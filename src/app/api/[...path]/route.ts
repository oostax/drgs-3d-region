import {supplementalOverview} from '@/lib/supplemental-data';
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  atlasPayload,
  descendantIds,
  getTerritories,
  organizationDetail,
  organizations,
  publicFile,
} from "@/lib/atlas-data";
import { modeOf, snapshotOf } from "@/lib/types";
import {
  createDossier,
  getDossier,
  listDossiers,
  saveDossier,
} from "@/lib/dossiers";
import {
  getImportStatus,
  launchKnownImport,
  launchImport,
  uploadDirectory,
} from "@/lib/import-jobs";
import { tileResponse } from "@/lib/tiles";
import { basemapResponse,terrainResponse } from "@/lib/basemap-cache";
import { operationsData } from "@/lib/operations-data";
import { incidentRecords } from "@/lib/incidents-data";
import {planningData,planningOrganizationDetail,listMeetingPlans,createMeetingPlan,refinePlanByRoad} from '@/lib/meeting-planner';
import {saveOrganizationLocation,syncPublicOrganizationLocations} from '@/lib/organization-locations';
import {
  getPublicRefreshStatus,
} from "@/lib/public-refresh";
import {liveSignalById,liveSignalChanges,liveSignalSnapshot,liveSources,liveSourcesCsv,type LiveSignalQuery} from '@/lib/live-store';
import {signalRelevance} from '@/lib/signal-relevance';
import {signalHasVerifiedMapLocation} from '@/lib/signal-location';
import {launchLiveRefresh} from '@/lib/live-refresh';
import {LocalDataUnavailable} from '@/lib/db';

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const json = (value: unknown, status = 200) =>
  NextResponse.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const liveJson=(req:NextRequest,value:{cursor?:string},status=200)=>{
  const etag=`W/\"live-${value.cursor||'0'}\"`;
  if(req.headers.get('if-none-match')===etag)return new Response(null,{status:304,headers:{ETag:etag,'Cache-Control':'no-cache, private'}});
  return NextResponse.json(value,{status,headers:{ETag:etag,'Cache-Control':'no-cache, private','X-Content-Type-Options':'nosniff'}});
};
function signalQuery(q:URLSearchParams):LiveSignalQuery{
  const days=Number(q.get('days'));const territory=q.get('territory')||'RU-TA';
  const ids=territory==='RU-TA'||territory==='RU'?undefined:[...descendantIds(getTerritories(),territory)];
  const bboxValues=(q.get('bbox')||'').split(',').map(Number);
  const validBbox=bboxValues.length===4&&bboxValues.every(Number.isFinite)&&bboxValues[0]<bboxValues[2]&&bboxValues[1]<bboxValues[3];
  return {archive:q.get('archive')==='true',regionId:(q.get('region')||'RU-TA').slice(0,30),territoryIds:ids,days:days===30||days===60?days:45,bbox:validBbox?bboxValues as [number,number,number,number]:undefined,ongoing:q.get('ongoing')==='true',category:q.get('category')?.slice(0,100)||undefined,limit:Math.min(1000,Math.max(1,Number(q.get('limit'))||500)),offset:Math.max(0,Number(q.get('offset'))||0)};
}
function localRequest(req: NextRequest) {
  const host = req.headers.get("host") || "";
  const origin = req.headers.get("origin");
  try {
    return (
      /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) &&
      req.headers.get("sec-fetch-site") !== "cross-site" &&
      (!origin || new URL(origin).host === host)
    );
  } catch {
    return false;
  }
}
function localOrigin(req: NextRequest) {
  const host = req.headers.get("host") || "127.0.0.1:3200";
  return (
    "http://" +
    (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)
      ? host
      : "127.0.0.1:3200")
  );
}
export async function GET(req: NextRequest, ctx: Context) {
  try {
    const route = (await ctx.params).path;
    const q = req.nextUrl.searchParams;
    const mode = modeOf(q.get("mode"));
    const snapshot = snapshotOf(q.get("snapshot"));
    if(route[0]==='work'&&!localRequest(req))return json({error:'Рабочие данные доступны только на локальном компьютере.'},403);
    if (route[0] === "tiles" && route[1] === "buildings")
      return tileResponse(req);
    if(route[0]==='terrain')return terrainResponse(route.slice(1));
    if (route[0] === "basemap")
      return basemapResponse(route.slice(1), localOrigin(req));
    if (mode === "work" && !localRequest(req))
      return json(
        { error: "Рабочий режим доступен на локальном компьютере." },
        403,
      );
    if (route[0] === "map" && route[1] === "style") {
      const style = fs
        .readFileSync(
          path.join(process.cwd(), "public/styles/atlas.json"),
          "utf8",
        )
        .replaceAll("/api/basemap/", localOrigin(req) + "/api/basemap/");
      return new Response(style, {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (route[0] === "atlas")
      return json(atlasPayload(mode, q.get("territory") || "RU-TA", snapshot, {residentSignals:q.get("residents") !== "false"}));
    if (route[0] === "territories") {
      const territories = getTerritories();
      return json(
        route[1]
          ? territories.find((t) => t.id === route[1]) || null
          : territories.map(({ geometry, ...t }) => t),
      );
    }
    if (route[0] === "organizations")
      return json(
        route[1]
          ? organizationDetail(mode, route[1], snapshot)
          : organizations(
              mode,
              (q.get("q") || "").slice(0, 200),
              snapshot,
              Number(q.get("offset")) || 0,
            ),
      );
    if(route[0]==='signals'&&route[1]==='changes')return liveJson(req,liveSignalChanges(signalQuery(q),q.get('after')||'0'));
    if(route[0]==='signals'&&route[1]){const signal=liveSignalById(route[1]);return signal?json(signal):json({error:'Сигнал не найден'},404);}
    if(route[0]==='signals')return liveJson(req,liveSignalSnapshot(signalQuery(q)));
    if (route[0] === "map" && route[1] === "features") {
      const p = atlasPayload(mode, q.get("territory") || "RU-TA", snapshot);
      return json({
        type: "FeatureCollection",
        features: p.signals
          .filter(signalHasVerifiedMapLocation)
          .map((s) => ({
            type: "Feature",
            id: s.id,
            geometry: { type: "Point", coordinates: s.coordinates },
            properties: {
              id: s.id,
              title: s.title,
              precision: s.precision,
              territoryId: s.territoryId,
              count: s.count || 1,
            },
          })),
      });
    }
    if(route[0]==='imports'&&route[1]==='supplemental')return mode==='public'?json({error:'Только рабочий режим'},403):json(supplementalOverview(mode));
    if (route[0] === "imports")
      return mode === "public"
        ? json({ error: "Источник доступен в рабочем режиме." }, 403)
        : json(getImportStatus());
    if (route[0] === "dossiers")
      return json(route[1] ? getDossier(route[1], mode) : listDossiers(mode));
    if (route[0] === "incidents")
      return json(
        incidentRecords(
          mode,
          q.get("territory") || "RU-TA",
          (q.get("q") || "").slice(0, 200),
          Math.max(0, Number(q.get("offset")) || 0),
        ),
      );
    if(route[0]==='sources'&&route[1]==='export')return new Response(liveSourcesCsv(),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="atlas-live-sources.csv"','Cache-Control':'no-store'}});
    if(route[0]==='sources'&&!route[1])return json(liveSources());
    if (route[0] === "sources" && route[1] === "refresh")
      return json(getPublicRefreshStatus());
    if(route[0]==='work'&&route[1]==='signal-relevance'){
      const signalId=(q.get('signalId')||'').slice(0,250);if(!signalId)return json({error:'Укажите signalId'},400);
      return json(signalRelevance(signalId,snapshot));
    }
    if (route[0] === "operations") return json(operationsData(mode));
    if (route[0] === 'planning') return json(route[1]?planningOrganizationDetail(mode,route[1]):planningData(mode,(q.get('q')||'').slice(0,200),Math.max(0,Number(q.get('offset'))||0)));
    if (route[0] === 'plans') {const plans=listMeetingPlans(mode);return json(route[1]?plans.find(plan=>plan.id===route[1])||null:plans);}
    if (route[0] === 'organization-locations') return json(route[1]?organizationDetail(mode,route[1])?.location||null:null);
    if (route[0] === "health")
      return json({ status: "ok", service: "sber-atlas" });
    return json({ error: "Не найдено" }, 404);
  } catch (error) {
    if (error instanceof LocalDataUnavailable) return json({error:error.message,code:'LOCAL_DATA_UNAVAILABLE'},503);
    console.error(
      "Atlas API read failed",
      error instanceof Error ? error.message : "Unknown error",
    );
    return json(
      { error: "Не удалось прочитать данные. Повторите запрос." },
      500,
    );
  }
}
export async function HEAD(req: NextRequest, ctx: Context) {
  const route = (await ctx.params).path;
  return route[0] === "tiles" && route[1] === "buildings"
    ? tileResponse(req, true)
    : new Response(null, { status: 404 });
}
const dossierInput = z.object({
  mode: z.enum(["work", "public"]),
  territoryId: z.string().max(80),
  signalIds: z.array(z.string().max(300)).max(100).default([]),
  organizationIds: z.array(z.string().max(100)).max(50).default([]),
  snapshot: z.enum(["current", "q1", "q2", "q3"]).default("current"),
});
const coordinatesInput=z.tuple([z.number().min(-180).max(180),z.number().min(-90).max(90)]);
const locationInput=z.object({mode:z.enum(['work','public']),orgId:z.string().min(1).max(120),kind:z.enum(['legal','office','meeting']),address:z.string().trim().min(1).max(1000),coordinates:coordinatesInput.nullable(),precision:z.enum(['building','street','settlement','territory','site']),sourceUrl:z.string().max(2000).optional(),confirmed:z.literal(true)});
const meetingPlanInput=z.object({mode:z.enum(['work','public']),title:z.string().trim().min(1).max(200),orgIds:z.array(z.string().min(1).max(120)).min(1).max(12),startAt:z.string().max(30),meetingMinutes:z.number().int().min(10).max(240),bufferMinutes:z.number().int().min(0).max(120),speedKmh:z.number().min(5).max(100),detourFactor:z.number().min(1).max(3),optimize:z.boolean(),startCoordinates:coordinatesInput.nullable().optional(),managerId:z.string().max(120).nullable().optional()});
export async function POST(req: NextRequest, ctx: Context) {
  if (!localRequest(req))
    return json(
      { error: "Изменения доступны только на локальном компьютере." },
      403,
    );
  const route = (await ctx.params).path;
  try {
    if(route[0]==='organization-locations'||route[0]==='plans'){
      const raw=await req.json();
      if(raw?.mode==='public'||req.nextUrl.searchParams.get('mode')==='public')return json({error:'Планирование клиентов доступно только в рабочем режиме.'},403);
      if(route[0]==='plans'){
        if(route[1]&&route[2]==='road'){const input=z.object({mode:z.literal('work'),shareCoordinates:z.literal(true)}).parse(raw);return json(await refinePlanByRoad(input.mode,route[1]));}
        const {mode,...input}=meetingPlanInput.parse(raw);return json(createMeetingPlan(mode,input),201);
      }
      if(route[1]==='sync'){const {mode}=z.object({mode:z.literal('work')}).parse(raw);return json(syncPublicOrganizationLocations(mode));}
      const {mode,...input}=locationInput.parse(raw);return json(saveOrganizationLocation(mode,input));
    }
    if (route[0] === "sources" && route[1] === "refresh")
      return json(launchLiveRefresh(), 202);
    if (route[0] === "dossiers") {
      const input = dossierInput.parse(await req.json());
      if (input.mode === "public" && input.organizationIds.length)
        return json(
          { error: "В презентационном режиме доступны публичные материалы." },
          400,
        );
      return json(createDossier(input), 201);
    }
    if (route[0] === "imports") {
      if (req.nextUrl.searchParams.get("mode") === "public")
        return json({ error: "Импорт доступен в рабочем режиме." }, 403);
      if (req.headers.get("content-type")?.includes("application/json")) {
        const body = z
          .object({ fileName: z.string().max(250) })
          .parse(await req.json());
        return json(launchKnownImport(body.fileName), 202);
      }
      const fileName = path.basename(
        decodeURIComponent(req.headers.get("x-file-name") || ""),
      );
      if (!/\.(xlsx|csv)$/i.test(fileName) || !req.body)
        return json({ error: "Выберите файл XLSX." }, 400);
      const max = 512 * 1024 * 1024;
      if (Number(req.headers.get("content-length")) > max)
        return json({ error: "Размер файла превышает 512 МБ." }, 413);
      const target = path.join(
        uploadDirectory(),
        `${randomUUID()}-${fileName}`,
      );
      let bytes = 0;
      try {
        await pipeline(
          Readable.fromWeb(req.body as never),
          new Transform({
            transform(chunk, encoding, callback) {
              bytes += chunk.length;
              callback(bytes > max ? new Error("File too large") : null, chunk);
            },
          }),
          fs.createWriteStream(target, { mode: 0o600 }),
        );
        return json(launchImport(target, fileName), 202);
      } catch (error) {
        fs.rmSync(target, { force: true });
        throw error;
      }
    }
    return json({ error: "Не найдено" }, 404);
  } catch (error) {
    return json(
      {
        error:
          error instanceof z.ZodError
            ? "Проверьте заполненные поля."
            : error instanceof Error
              ? error.message
              : "Не удалось выполнить действие.",
      },
      400,
    );
  }
}
export async function PATCH(req: NextRequest, ctx: Context) {
  if (!localRequest(req))
    return json({ error: "Изменения доступны только локально." }, 403);
  try {
    const route = (await ctx.params).path;
    if(route[0]==='sources'&&route[1]==='refresh'&&!localRequest(req))return json({error:'Обновление источников доступно только на локальном компьютере.'},403);
    if (route[0] !== "dossiers" || !route[1])
      return json({ error: "Не найдено" }, 404);
    const body = z
      .object({
        mode: z.enum(["work", "public"]),
        title: z.string().min(1).max(200),
        questions: z.string().max(15000),
        actions: z.string().max(15000),
        notes: z.string().max(20000),
      })
      .parse(await req.json());
    const existing = getDossier(route[1], body.mode);
    if (!existing) return json({ error: "Досье не найдено" }, 404);
    return json(
      saveDossier({
        ...existing,
        ...body,
        updatedAt: new Date().toISOString(),
      }),
    );
  } catch {
    return json(
      { error: "Не удалось сохранить досье. Проверьте заполненные поля." },
      400,
    );
  }
}
