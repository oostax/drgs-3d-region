#!/usr/bin/env python3
"""Export a traceable graph of active signals and their real data relations.

This projection intentionally keeps the interactive graph compact: documents and
evidence are aggregated into attributes on a signal-to-source edge instead of
turning every publication into a node.  Exact addresses are never inferred from
territory-level data; their precision remains an explicit signal attribute.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = ROOT / "data/live/atlas-live.sqlite"
DEFAULT_OUTPUT = ROOT / "artifacts/live-signal-graph.json"


def node(node_id: str, kind: str, label: str, **attributes: Any) -> dict[str, Any]:
    return {"id": node_id, "kind": kind, "label": label, **attributes}


def edge(source: str, target: str, relation: str, **attributes: Any) -> dict[str, Any]:
    return {"source": source, "target": target, "relation": relation, **attributes}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    connection = sqlite3.connect(args.db)
    connection.row_factory = sqlite3.Row
    events = connection.execute(
        """SELECT * FROM events WHERE deleted=0
           ORDER BY last_evidence_at DESC, id"""
    ).fetchall()
    links = connection.execute(
        """SELECT ed.event_id, ed.relation, ed.similarity, d.source_id,
                  d.id AS document_id, d.deleted_at,
                  s.name AS source_name, s.source_kind AS source_kind,
                  s.ai_allowed, s.fetch_allowed, s.display_allowed
           FROM event_documents ed
           JOIN events e ON e.id=ed.event_id AND e.deleted=0
           JOIN documents d ON d.id=ed.document_id AND d.deleted_at IS NULL
           JOIN sources s ON s.id=d.source_id
           ORDER BY ed.event_id, d.source_id, d.id"""
    ).fetchall()
    evidence = connection.execute(
        """SELECT event_id, source_id, COUNT(*) AS count
           FROM event_evidence
           WHERE event_id IN (SELECT id FROM events WHERE deleted=0)
           GROUP BY event_id, source_id"""
    ).fetchall()
    connection.close()

    evidence_by_pair = {(item["event_id"], item["source_id"]): item["count"] for item in evidence if item["source_id"]}
    documents_by_pair: dict[tuple[str, str], list[sqlite3.Row]] = defaultdict(list)
    for item in links:
        documents_by_pair[(item["event_id"], item["source_id"])].append(item)

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    source_nodes: dict[str, dict[str, Any]] = {}
    territory_nodes: set[str] = set()
    state_nodes: set[str] = set()
    topic_nodes: set[str] = set()
    category_nodes: set[str] = set()

    for item in events:
        raw = json.loads(item["data_json"] or "{}")
        usefulness = raw.get("signalUsefulness") or {}
        signal_id = f"signal:{item['id']}"
        nodes.append(node(
            signal_id,
            "signal",
            item["title"],
            state=item["state"], severity=item["severity"], confidence=item["confidence"],
            precision=item["precision"], territoryId=item["territory_id"], category=item["category"],
            topic=item["topic"], reviewed=bool(item["reviewed"]),
            showOnMap=usefulness.get("showOnMap") is True,
            usefulnessLevel=usefulness.get("level", "unknown"),
            evidenceAt=item["last_evidence_at"], hasCoordinates=item["longitude"] is not None and item["latitude"] is not None,
        ))
        if item["territory_id"]:
            territory_id = f"territory:{item['territory_id']}"
            if territory_id not in territory_nodes:
                territory_nodes.add(territory_id)
                nodes.append(node(territory_id, "territory", item["territory_id"]))
            edges.append(edge(signal_id, territory_id, "located_in", precision=item["precision"]))
        for kind, value, known in (("state", item["state"], state_nodes), ("topic", item["topic"], topic_nodes), ("category", item["category"], category_nodes)):
            relation_id = f"{kind}:{value}"
            if relation_id not in known:
                known.add(relation_id)
                nodes.append(node(relation_id, kind, value))
            edges.append(edge(signal_id, relation_id, f"has_{kind}"))

    for (event_id, source_id), documents in documents_by_pair.items():
        first = documents[0]
        source_node_id = f"source:{source_id}"
        if source_id not in source_nodes:
            source_nodes[source_id] = node(
                source_node_id, "source", first["source_name"], sourceKind=first["source_kind"],
                aiAllowed=bool(first["ai_allowed"]), fetchAllowed=bool(first["fetch_allowed"]),
                displayAllowed=bool(first["display_allowed"]),
            )
        relations = sorted({document["relation"] for document in documents})
        similarities = [document["similarity"] for document in documents if document["similarity"] is not None]
        edges.append(edge(
            f"signal:{event_id}", source_node_id, "reported_by", documentCount=len(documents),
            evidenceCount=evidence_by_pair.get((event_id, source_id), 0), relations=relations,
            meanSimilarity=round(sum(similarities) / len(similarities), 4) if similarities else None,
        ))

    nodes.extend(source_nodes.values())
    summary = {
        "activeSignals": len(events),
        "sourcesLinked": len(source_nodes),
        "signalsWithSource": len({event_id for event_id, _ in documents_by_pair}),
        "signalsWithoutLinkedActiveDocument": len(events) - len({event_id for event_id, _ in documents_by_pair}),
        "nodes": len(nodes), "edges": len(edges),
        "byState": dict(Counter(item["state"] for item in events).most_common()),
        "byPrecision": dict(Counter(item["precision"] for item in events).most_common()),
        "byMapEligibility": dict(Counter(
            "map_candidate" if (json.loads(item["data_json"] or "{}").get("signalUsefulness") or {}).get("showOnMap") is True else "not_on_map"
            for item in events
        ).most_common()),
        "methodNote": "Source edges aggregate actual event_documents and event_evidence rows. Location precision is preserved; territory links do not imply an exact address.",
    }
    output = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "database": str(args.db), "summary": summary,
        "nodes": nodes, "edges": edges,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
