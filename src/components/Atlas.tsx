"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  Layers,
  LocateFixed,
  Compass,
  Plus,
  Minus,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Map,
  Radio,
  Building2,
  Landmark,
  FileText,
  Play,
  BarChart3,
  X,
  Check,
  Database,
  ShieldCheck,
  Globe2,
  ArrowLeft,
  SlidersHorizontal,
  MapPin,
  BriefcaseBusiness,
  Route,
  Clock3,
} from "lucide-react";
import {
  AtlasPayload,
  BankOffice,
  Coordinates,
  Mode,
  Organization,
  Signal,
  Territory,
  View,
  SNAPSHOTS,
} from "@/lib/types";
import { LANDMARKS } from "@/lib/landmarks";
import { money, number, publicationDateTime, shortDate, shortDateTime } from "@/lib/format";
import { Back, Empty, IconButton, Modal, Source } from "./ui";
import DossierEditor from "./DossierEditor";
import IncidentRecords from "./IncidentRecords";
import type { AtlasMapBuilding } from "./AtlasMap";
import MapMenu from "./MapMenu";
import BankPriorities from "./BankPriorities";
import SberWorkspace from './SberWorkspace';
import {SBER_HEAD_OFFICES,sberOfficeRole} from '@/lib/sber-structure';
import type {ClientMapPayload} from '@/lib/client-map-types';
import {territoryPriorities} from "@/lib/territory-priorities";
import SceneClock from "./SceneClock";
import {normalizeSceneLifecycle} from '@/lib/scene-lifecycle';
import {territorialAssessment} from '@/lib/territorial-assessment';
import {reviewSignal, deduplicateSignalFeed, groupSignalPublications, sberSignalContext} from '@/lib/signal-usefulness';
import SignalDetail, {signalHeadline} from "./SignalDetail";
import LiveSignalStatus from "./LiveSignalStatus";
import SignalRelevance from "./SignalRelevance";
import {useLiveSignalDetail, useLiveSignals, type LiveWindowDays} from "./use-live-signals";
import SignalCategoryIcon from "./SignalCategoryIcon";
import {signalMarker,signalStatusPresentation,categoryIcon,signalGroup,SIGNAL_GROUPS,SIGNAL_STATUS_LEGEND} from "@/lib/signal-markers";
import {signalPriority} from '@/lib/signal-priority';
import {isResidentReport, signalMatchesFlow, signalVisibleInView, stateForSignalPeriod, type SignalFlow} from "@/lib/signal-view";
import type { MeetingPlan } from "@/lib/planning-types";
import {DEFAULT_MAP_3D, nextMapMode} from "@/lib/map-camera-mode";
import { clientViewLayers } from "@/lib/client-map-visibility";
import {territoryScopeIds} from '@/lib/map-camera-scope';
const AtlasMap = dynamic(() => import("./AtlasMap"), {
  ssr: false,
  loading: () => (
    <div className="map-loading">
      <span className="spinner" />
      Открываем Татарстан…
    </div>
  ),
});
const SourcesPanel = dynamic(() => import("./SourcesPanel"), { ssr: false });
const PlanningPanel = dynamic(() => import("./PlanningPanel"), { ssr: false });
const TerritoryAnalytics = dynamic(() => import("./TerritoryAnalytics"), { ssr: false });
const ClientPortfolio = dynamic(() => import("./ClientPortfolio"), { ssr: false });
const categories = [
  "Все",
  "ЖКХ",
  "Благоустройство",
  "Дороги",
  "Образование",
  "Инвестиции",
];
const categoryName = (s: string) =>
  ({
    economy: "Экономика",
    business: "Экономика и бизнес",
    landscape: "Благоустройство",
    social: "Социальные вопросы",
    communication: "Связь и телевидение",
    construction: "Строительство",
    investment: "Инвестиции",
    tourism: "Туризм",
    infrastructure: "Инфраструктура",
    housing: "ЖКХ",
    education: "Образование",
    technology: "Технологии",
    safety: "Безопасность",
    healthcare: "Здравоохранение",
    culture: "Культура",
    transport: "Транспорт",
    utilities: "ЖКХ",
    roads: "Дороги",
    flood: "Подтопления",
    fire: "Пожары",
    waste: "Обращение с отходами",
    weather: "Погодные риски",
    ecology: "Экология",
    health: "Здравоохранение",
    other: "Другие темы",
    planning: "Планы и проекты",
  })[s] || s;
const hasTatarScript = (signal: Signal) => /[әөүҗңһӘӨҮҖҢҺ]/.test(`${signal.title} ${signal.summary}`);
const bankName = (s: string) =>
  ({
    sber: "Сбер",
    akbars: "Ак Барс",
    vtb: "ВТБ",
    psb: "ПСБ",
    gazprombank: "Газпромбанк",
  })[s] || s;
const kindNames: Record<string, string> = {
  region: "Регион",
  district: "Муниципальный район",
  urban_district: "Городской округ",
  settlement: "Поселение",
};
const precisionNames = {
  territory: "Территория",
  settlement: "Населённый пункт",
  street: "Улица",
  building: "Объект",
  site: "Территория объекта",
};
const viewNames: Record<View, string> = {
  overview: "Территория",
  signals: "Сигналы",
  organizations: "Организации",
  banks: "Банки",
  places: "Места",
};
const viewIcons = {
  overview: Map,
  signals: Radio,
  organizations: BriefcaseBusiness,
  banks: Building2,
  places: Landmark,
};
type Focus = {
  bbox?: [number, number, number, number];
  coordinates: Coordinates;
  zoom: number;
  pitch?: number;
  bearing?: number;
  nonce: number;
};
type Selection =
  | { type: "signal"; id: string }
  | { type: "organization"; id: string }
  | { type: "office"; id: string }
  | { type: "landmark"; id: string }
  | { type: "building"; id: string; building: AtlasMapBuilding }
  | null;
export default function Atlas({
  initialMode: _initialMode = "work",
}: {
  initialMode?: Mode;
}) {
  const liveReadRef=useRef<(id:string)=>void>(()=>{});
  const [mode, setMode] = useState<Mode>("work"),
    [territoryId, setTerritoryId] = useState("RU-TA"),
    [snapshot, setSnapshot] = useState("current"),
    [data, setData] = useState<AtlasPayload | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [residentReports,setResidentReports]=useState(false);
  const [signalQuality,setSignalQuality]=useState<'useful'|'all'>('useful');
  const [signalSort,setSignalSort]=useState<'relevance'|'significance'|'date'>('relevance');
  const [hoveredSignalId,setHoveredSignalId]=useState<string|null>(null);
  const [signalTerritoryContextId,setSignalTerritoryContextId]=useState<string|null>(null);
  const [regionData, setRegionData] = useState<{mode: Mode; payload: AtlasPayload} | null>(null);
  const [otherRegion, setOtherRegion] = useState<{
      id: string;
      name: string;
    } | null>(null),
    [view, setView] = useState<View>("overview"),
    [selection, setSelection] = useState<Selection>(null),
    [focus, setFocus] = useState<Focus | null>(null),
    [is3D, set3D] = useState(DEFAULT_MAP_3D),
    [mapStatus, setMapStatus] = useState<{
      zoom: number;
      networkError: boolean;
      webgl: boolean;
      ready?: boolean;
      center?: Coordinates;
      bbox?: [number,number,number,number];
      pitch?: number;
      bearing?: number;
    }>({ zoom: 6.35, networkError: false, webgl: true });
  const [layers, setLayers] = useState({
      signals: true,
      banks: true,
      buildings: true,
      landmarks: true,
      boundaries: true,
      terrain: false,
    }),
    [panelOpen, setPanelOpen] = useState(false),
    [expanded, setExpanded] = useState(false),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [signalLimit, setSignalLimit] = useState(40),
    [bankLimit, setBankLimit] = useState(40),
    [category, setCategory] = useState("Все"),
    [bank, setBank] = useState("Все банки");
  const mapLayers = useMemo(() => clientViewLayers(layers, mode === 'work' && view === 'organizations'), [layers, mode, view]);
  type Overlay = 'map' | 'search' | 'sources' | 'planning' | 'dossiers' | 'incidents' | 'analytics';
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const showSources = overlay === 'sources', exploreOpen = overlay === 'map', showPlanning = overlay === 'planning',
    showDossiers = overlay === 'dossiers', showIncidents = overlay === 'incidents', showSearch = overlay === 'search';
  const setOverlayVisible = useCallback((name: Overlay, visible: boolean) => setOverlay(current => visible ? name : current === name ? null : current), []);
  const setShowSources = useCallback((visible: boolean) => setOverlayVisible('sources', visible), [setOverlayVisible]);
  const setExploreOpen = useCallback((visible: boolean) => setOverlayVisible('map', visible), [setOverlayVisible]);
  const setShowPlanning = useCallback((visible: boolean) => setOverlayVisible('planning', visible), [setOverlayVisible]);
  const setShowDossiers = useCallback((visible: boolean) => setOverlayVisible('dossiers', visible), [setOverlayVisible]);
  const setShowIncidents = useCallback((visible: boolean) => setOverlayVisible('incidents', visible), [setOverlayVisible]);
  const setShowSearch = useCallback((visible: boolean) => setOverlayVisible('search', visible), [setOverlayVisible]);
  const contextVisible = panelOpen && overlay === null;
  const [perspective,setPerspective]=useState<'region'|'sber'>('region');
  const [clientMapData,setClientMapData]=useState<ClientMapPayload|null>(null);
  const clientInns=useMemo(()=>new Set(clientMapData?.portfolioInns||[]),[clientMapData]);
  const [portfolioFilter, setPortfolioFilter] = useState('scope=deals');
  const [clientMapError, setClientMapError] = useState('');
  const [clientStackIds, setClientStackIds] = useState<string[]>([]), [clientStackLimit, setClientStackLimit] = useState(40);
  const activePortfolioFilter = view === 'organizations' ? portfolioFilter : 'scope=deals';
  useEffect(() => {
    setClientMapData(null); setClientMapError('');
    if (mode !== 'work') { setClientStackIds([]); return; }
    const controller = new AbortController();
    fetch(`/api/portfolio?mode=work&map=true&snapshot=${snapshot}&${activePortfolioFilter}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Адреса клиентов недоступны'); if (!controller.signal.aborted) setClientMapData(result); })
      .catch(e => { if (!controller.signal.aborted) setClientMapError(e instanceof Error ? e.message : 'Адреса клиентов недоступны'); });
    return () => controller.abort();
  }, [mode, refresh, snapshot, activePortfolioFilter]);
  const refreshClients = useCallback(() => setRefresh(value => value + 1), []);
  const openClient = (id: string) => { setClientStackIds([]); setSelection({ type: 'organization', id }); setView('organizations'); setPanelOpen(true); setOverlay(null); };
  const planClient = (id: string) => { setPlanningOrgId(id); setOverlay('planning'); };

  const [liveDays,setLiveDays]=useState<LiveWindowDays>(45),[liveOngoing,setLiveOngoing]=useState(false),[signalStackIds,setSignalStackIds]=useState<string[]>([]),[newBatchIds,setNewBatchIds]=useState<string[]>([]);
  const [appearance, setAppearance] = useState<{
    timeMode: "auto" | "manual";
    hour: number;
    life: boolean;
  }>({ timeMode: "auto", hour: 14, life: true });
  const [routePlan, setRoutePlan] = useState<MeetingPlan | null>(null);
  const [planningOrgId, setPlanningOrgId] = useState<string | undefined>();
  const [organizations, setOrganizations] = useState<Organization[]>([]),
    [orgTotal, setOrgTotal] = useState(0),
    [orgQuery, setOrgQuery] = useState(""),
    [orgDetail, setOrgDetail] = useState<Organization | null>(null),
    [orgLoading, setOrgLoading] = useState(false),
    [offset, setOffset] = useState(0);
  const [signalIds, setSignalIds] = useState<string[]>([]),
    [organizationIds, setOrganizationIds] = useState<string[]>([]),
    [toast, setToast] = useState(""),
    [tour, setTour] = useState(-1),
    [online, setOnline] = useState(true);
  const signalLookupRef = useRef<Signal[]>([]);
  const routeFeatures = useMemo<GeoJSON.FeatureCollection | undefined>(
    () =>
      routePlan
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: { method: routePlan.method },
                geometry: routePlan.geometry,
              },
              ...routePlan.stops.map((stop, index) => ({
                type: "Feature" as const,
                properties: { stop: index + 1, name: stop.name },
                geometry: {
                  type: "Point" as const,
                  coordinates: stop.coordinates,
                },
              })),
            ],
          }
        : undefined,
    [routePlan],
  );
  const focusedOrganization = useMemo(() => {
    if (mode !== "work" || selection?.type !== "organization" || !orgDetail)
      return null;
    const point =
      orgDetail.location?.meeting ||
      orgDetail.location?.office ||
      orgDetail.location?.legalAddress;
    return point?.coordinates
      ? {
          id: orgDetail.id,
          name: orgDetail.name,
          coordinates: point.coordinates,
          addressKind: orgDetail.location?.meeting
            ? "Место встречи"
            : orgDetail.location?.office
              ? "Адрес организации"
              : "Юридический адрес",
        }
      : null;
  }, [mode, selection?.type, orgDetail]);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("mode") === "public") setMode("public");
    if (q.get("scale") === "city") fly([49.12, 55.79], 13, 48);
    if (q.get("scale") === "object") fly([49.10516, 55.79835], 17.3, 58);
    const on = () => setOnline(navigator.onLine);
    on();
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
    };
  }, []);
  const loadResidentSignals = residentReports && (mapStatus.ready === true || mapStatus.webgl === false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/atlas?mode=${mode}&territory=RU-TA&snapshot=${snapshot}&residents=${loadResidentSignals}`, {signal:controller.signal})
      .then(async response => { if (!response.ok) throw new Error('region-data'); return response.json() as Promise<AtlasPayload>; })
      .then(payload => { setRegionData({mode, payload}); setError(""); })
      .catch(error => {
        if (error.name !== 'AbortError') {
          setError("Не удалось загрузить данные региона. Проверьте локальный сервер.");
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [mode, snapshot, refresh, loadResidentSignals]);
  useEffect(() => {
    if (territoryId !== "RU-TA" || regionData?.mode !== mode) return;
    setData(regionData.payload); setLoading(false); setError("");
  }, [regionData, territoryId, mode]);
  useEffect(() => {
    if (territoryId === "RU-TA") return;
    const c = new AbortController();
    setLoading(true);
    setError("");
    fetch(
      `/api/atlas?mode=${mode}&territory=${territoryId}&snapshot=${snapshot}&residents=${loadResidentSignals}`,
      { signal: c.signal },
    )
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        return d;
      })
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError")
          setError("Не удалось загрузить данные. Проверьте локальный сервер.");
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [mode, territoryId, snapshot, refresh, loadResidentSignals]);
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 150);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    if (
      !showSearch
    )
      return;
    if (mode === "public") {
      setOrganizations([]);
      setOrgTotal(0);
      return;
    }
    const c = new AbortController();
    setOrgLoading(true);
    const t = setTimeout(
      () =>
        fetch(
          `/api/organizations?mode=work&snapshot=${snapshot}&q=${encodeURIComponent(showSearch ? query : orgQuery)}&offset=${offset}`,
          { signal: c.signal },
        )
          .then((r) => r.json())
          .then((d) => {
            setOrganizations(d.items || []);
            setOrgTotal(d.total || 0);
          })
          .catch((e) => {
            if (e.name !== "AbortError")
              setError("Не удалось прочитать список организаций.");
          })
          .finally(() => {
            if (!c.signal.aborted) setOrgLoading(false);
          }),
      180,
    );
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [
    mode,
    view,
    orgQuery,
    query,
    showSearch,
    snapshot,
    offset,
    selection?.type,
    refresh,
  ]);
  useEffect(() => {
    if (selection?.type !== "organization") return;
    const c = new AbortController();
    setOrgDetail(null);
    fetch(
      `/api/organizations/${encodeURIComponent(selection.id)}?mode=${mode}&snapshot=${snapshot}`,
      { signal: c.signal },
    )
      .then((r) => r.json())
      .then((organization: Organization) => {
        setOrgDetail(organization);
        const point =
          organization.location?.meeting || organization.location?.office;
        if (point?.coordinates) fly(point.coordinates, 17.4, 55);
      })
      .catch(() => {});
    return () => c.abort();
  }, [selection, mode, snapshot, refresh]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowSearch(true);
      }
      if (e.key === "Escape") {
        setOverlay(null);
        setShowSearch(false);
        setSelection(null);
        setPanelOpen(false);
        setExploreOpen(false);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  function fly(
    coordinates: Coordinates,
    zoom: number,
    pitch = 50,
    bearing = 0,
    bbox?: [number, number, number, number],
  ) {
    const adjustedZoom =
      zoom === 6.35 && window.matchMedia("(max-width:760px)").matches
        ? 5.1
        : zoom;
    setFocus({
      coordinates,
      zoom: adjustedZoom,
      bbox,
      pitch,
      bearing,
      nonce: Date.now(),
    });
  }
  const chooseTerritory = useCallback(
    (id: string) => {
      setOverlay(null);
      setOtherRegion(null);
      setTerritoryId(id);
      setSelection(null);
      setSignalIds([]);
      setOrganizationIds([]);
      setShowSearch(false);
      setExpanded(false);
      setPanelOpen(false);
      setExploreOpen(false);
      setTour(-1);
      setView("overview");
      const t = data?.territories.find((t) => t.id === id);
      if (t?.center)
        fly(
          t.center,
          t.kind === "region"
            ? 6.35
            : t.kind === "district"
              ? 9
              : t.kind === "urban_district"
                ? 11.8
                : 13.5,
          t.kind === "region" ? 0 : 45,
        );
    },
    [data?.territories],
  );
  const chooseSignal = useCallback(
    (id: string) => {
      liveReadRef.current(id);
      setOverlay(null);
      setSignalStackIds([]);
      setSelection({ type: "signal", id });
      setView("signals");
      setExpanded(true);
      setPanelOpen(true);
      const signal = signalLookupRef.current.find((s) => s.id === id);
      const territory = data?.territories.find(
        (t) => t.id === signal?.territoryId,
      );
      if (signal?.coordinates)
        fly(
          signal.coordinates,
          signal.precision === "building"
            ? 18.4
            : signal.precision === "street"
              ? 17.3
              : signal.precision === "site"
                ? (signal.siteZoom ?? 15.5)
                : 12.5,
          48,
          0,
          // A street bbox may be kilometres long (and a compound signal may
          // contain several streets). Fitting it would undo the object-level
          // zoom; use the evidenced street anchor and retain its line overlay.
          signal.precision === "street" ? undefined : signal.siteBbox,
        );
      else if (territory?.center) {
        setToast(
          `Показана территория: ${territory.name}. Точный объект не определён.`,
        );
        fly(
          territory.center,
          territory.kind === "region"
            ? 6.35
            : territory.kind === "district"
              ? 9.5
              : 12.5,
          40,
        );
      }
    },
    [data],
  );
  const chooseOffice = useCallback(
    (id: string) => {
      setOverlay(null);
      setSelection({ type: "office", id });
      setView("banks");
      setExpanded(true);
      setPanelOpen(true);
      const office = SBER_HEAD_OFFICES.find(o=>o.id===id)||(regionData?.mode === mode ? regionData.payload : data)?.offices.find((o) => o.id === id);
      if (office?.coordinates) fly(office.coordinates, sberOfficeRole(office)==='ТБ'?6.4:17.7, sberOfficeRole(office)==='ТБ'?0:60, 20);
    },
    [data, regionData, mode],
  );
  const chooseLandmark = useCallback((id: string) => {
    setOverlay(null);
    setSelection({ type: "landmark", id });
    setView("places");
    const l = LANDMARKS.find((l) => l.id === id);
    if (l) fly(l.coordinates as Coordinates, 17.7, 60, 20);
    setExpanded(false);
    setPanelOpen(true);
  }, []);
  const onMapStatus = useCallback(
    (s: {
      zoom: number;
      networkError: boolean;
      webgl: boolean;
      ready?: boolean;
      center?: Coordinates;
      bbox?: [number,number,number,number];
      pitch?: number;
      bearing?: number;
    }) => setMapStatus(s),
    [],
  );
  function switchMode() {
    const u = new URL(location.href);
    u.searchParams.set("mode", mode === "work" ? "public" : "work");
    history.replaceState(null, "", u);
    setShowIncidents(false);
    setData(null);
    setSelection(null);
    setOrganizations([]);
    setOrgDetail(null);
    setSignalIds([]);
    setSignalStackIds([]);
    setOrganizationIds([]);
    setShowDossiers(false);
    setShowSources(false);
    setShowPlanning(false);
    setRoutePlan(null);
    setPlanningOrgId(undefined);
    setPanelOpen(false);
    setExploreOpen(false);
    setTour(-1);
    setView("overview");
    setMode(mode === "work" ? "public" : "work");
    setToast(
      mode === "work"
        ? "Презентация: только публичные данные"
        : "Рабочий режим: локальные данные",
    );
  }
  function changeView(v: View) {
    setOverlay(null);
    setView(v);
    setSelection(null);
    setExpanded(true);
    setPanelOpen(true);
    setExploreOpen(false);
    if (v === "banks") setLayers((l) => ({ ...l, banks: true }));
    if (v === "signals") setLayers((l) => ({ ...l, signals: true }));
  }
  function toggleSignal(id: string) {
    setSignalIds((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : [...p, id],
    );
    setToast(
      signalIds.includes(id)
        ? "Сигнал убран из повестки"
        : "Сигнал добавлен в повестку",
    );
  }
  function toggleOrg(id: string) {
    setOrganizationIds((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : [...p, id],
    );
    setToast(
      organizationIds.includes(id)
        ? "Организация убрана"
        : "Организация добавлена в повестку",
    );
  }
  const tourSteps = [
    {
      title: "Татарстан целиком",
      text: "Муниципалитеты и сигналы на одной карте",
      c: [51, 55.35] as Coordinates,
      z: 6.35,
      p: 0,
    },
    {
      title: "Казань",
      text: "Городская инфраструктура и банковская сеть",
      c: [49.115, 55.795] as Coordinates,
      z: 13.5,
      p: 50,
    },
    {
      title: "Казанский кремль",
      text: "Авторские модели на реальных контурах",
      c: [49.10516, 55.79835] as Coordinates,
      z: 17.6,
      p: 60,
    },
    {
      title: "Иннополис",
      text: "Университет, технопарк и проекты",
      c: [48.748, 55.7526] as Coordinates,
      z: 15.7,
      p: 55,
    },
    {
      title: "Болгар",
      text: "Белая мечеть и культурная инфраструктура",
      c: [49.06126, 54.96613] as Coordinates,
      z: 17.3,
      p: 58,
    },
  ];
  function tourGo(i: number) {
    const s = tourSteps[i];
    setTour(i);
    setSelection(null);
    setPanelOpen(false);
    setExploreOpen(false);
    fly(s.c, s.z, s.p, 15);
  }
  function startTour() {
    if (mode === "work") {
      switchMode();
      setMode("public");
    }
    setTerritoryId("RU-TA");
    setLayers((l) => ({ ...l, banks: true }));
    tourGo(0);
  }

  const [officeStackIds,setOfficeStackIds]=useState<string[]>([]);
  const [signalState,setSignalState]=useState<SignalFlow>('all');
  const [signalPeriod,setSignalPeriod]=useState<'current'|'resolved'|'archive'>('current');
  const [subCategory,setSubCategory]=useState('Все категории');
  const [asOf,setAsOf]=useState(()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date()));
  useEffect(()=>{const update=()=>setAsOf(new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date()));const timer=setInterval(update,60000);return()=>clearInterval(timer);},[]);
  const territories = useMemo(
    () => data?.territories || [],
    [data?.territories],
  );
  const territory = territories.find((t) => t.id === territoryId);
  // Keep the primary feed territory-complete: a spatial bbox would discard
  // municipality-level reports that intentionally have no coordinates.
  const liveFeed=useLiveSignals({mode,region:'RU-TA',territory:'RU-TA',days:liveDays,archive:signalPeriod==='archive',ongoing:liveOngoing,enabled:!otherRegion});
  liveReadRef.current=liveFeed.markRead;
  const regionalPayload = regionData?.mode === mode ? regionData.payload : data;
  const combinedSignals=useMemo(()=>{const items=new globalThis.Map((regionalPayload?.signals||[]).map(signal=>[signal.id,signal]));for(const signal of liveFeed.signals)items.set(signal.id,signal);return deduplicateSignalFeed([...items.values()]);},[regionalPayload?.signals,liveFeed.signals]);
  const visibleUnreadIds=useMemo(()=>liveFeed.unreadIds.filter(id=>{const signal=combinedSignals.find(item=>item.id===id);return signal&&!hasTatarScript(signal);}),[combinedSignals,liveFeed.unreadIds]);
  signalLookupRef.current=combinedSignals;
  const openNewestUnread=useCallback(()=>{
    const ids=combinedSignals.filter(signal=>visibleUnreadIds.includes(signal.id)).sort((a,b)=>Date.parse(b.live?.eventTime||b.publishedAt)-Date.parse(a.live?.eventTime||a.publishedAt)).map(signal=>signal.id);
    setNewBatchIds(ids);
    setSignalQuality(ids.length?'all':'useful');setSignalState('all');setSignalPeriod('current');setCategory('Все');setSubCategory('Все категории');setPerspective('region');setSignalTerritoryContextId(null);setSignalStackIds([]);
    setSignalLimit(Math.max(40,ids.length));
    // This badge opens a feed, not a geographical overview. Keep the camera
    // where the user left it; the explicit "Вся карта" control owns the
    // Татарстан-wide flight.
    changeView('signals');
  },[combinedSignals,visibleUnreadIds,changeView]);
  const attentionSignalIds=visibleUnreadIds;
  const signalCategories=useMemo(()=>[...new Set(combinedSignals.filter(s=>category==='Все'||categoryName(s.category)===category).flatMap(s=>s.categoryBreakdown?.map(c=>c.name)||[]))].sort((a,b)=>a.localeCompare(b,'ru')),[combinedSignals,category]);
  const priorities=useMemo(()=>{if(!data)return [];const byId=new globalThis.Map(data.territories.map(t=>[t.id,t]));return territoryPriorities(combinedSignals.filter(s=>reviewSignal(s).showOnMap),regionalPayload?.offices||data.offices,data.territories,{asOf}).map(p=>({...p,kind:byId.get(p.id)?.kind||'unknown',parentId:byId.get(p.id)?.parentId||null}));},[combinedSignals,data,regionalPayload?.offices,asOf]);
  const mapSignals = useMemo(() => combinedSignals.filter(s=>{
    return !hasTatarScript(s)
      &&(signalQuality==='all'||reviewSignal(s).showOnMap)
      &&(perspective!=='sber'||Boolean(sberSignalContext(s,clientInns)))
      &&signalVisibleInView(s,asOf,{period:signalPeriod,days:liveDays,residentReports:mode==='work'&&residentReports,usefulOnly:signalQuality==='useful'})
      &&signalMatchesFlow(s,signalState)
      &&(category==='Все'||categoryName(s.category)===category)
      &&(subCategory==='Все категории'||s.categoryBreakdown?.some(c=>c.name===subCategory));
  }).map(s=>subCategory==='Все категории'?s:{...s,categoryBreakdown:s.categoryBreakdown?.filter(c=>c.name===subCategory)}).sort((a,b)=>{const date=b.publishedAt.localeCompare(a.publishedAt);if(signalSort==='date')return date;if(signalSort==='significance')return signalPriority(b).rank-signalPriority(a).rank||territorialAssessment(b).regionalScore-territorialAssessment(a).regionalScore||date;return (perspective==='region'?reviewSignal(b).score-reviewSignal(a).score:(sberSignalContext(b,clientInns)?.score||0)-(sberSignalContext(a,clientInns)?.score||0))||territorialAssessment(b).regionalScore-territorialAssessment(a).regionalScore||date;}),[combinedSignals,category,subCategory,signalPeriod,signalState,signalQuality,signalSort,asOf,perspective,liveDays,residentReports,mode,clientInns]);
  // Keep every regional signal in the feed. Map context only promotes the
  // current municipality; it never hides the rest of Татарстан.
  const signals = useMemo(()=>{
    if(!signalTerritoryContextId)return mapSignals;
    const localIds=territoryScopeIds(territories,signalTerritoryContextId);
    return [...mapSignals].sort((a,b)=>Number(localIds.has(b.territoryId||''))-Number(localIds.has(a.territoryId||'')));
  },[mapSignals,signalTerritoryContextId,territories]);
  const signalTerritoryContext=signalTerritoryContextId?territories.find(item=>item.id===signalTerritoryContextId):null;
  const signalTerritoryContextIds=useMemo(()=>signalTerritoryContextId?territoryScopeIds(territories,signalTerritoryContextId):null,[signalTerritoryContextId,territories]);
  const localSignalCount=signalTerritoryContextIds?signals.filter(signal=>signalTerritoryContextIds.has(signal.territoryId||'')).length:0;
  const signalCards=useMemo(()=>groupSignalPublications(signals),[signals]);
  const visibleSignalCards=useMemo(()=>{
    if(!newBatchIds.length)return signalCards;
    const order=new globalThis.Map(newBatchIds.map((id,index)=>[id,index]));
    return signalCards.filter(card=>card.locations.some(signal=>order.has(signal.id))).sort((a,b)=>Math.min(...a.locations.map(signal=>order.get(signal.id)??Infinity))-Math.min(...b.locations.map(signal=>order.get(signal.id)??Infinity)));
  },[signalCards,newBatchIds]);
  const mapOffices = useMemo(() => (regionalPayload?.offices || []).filter(office => bank === 'Все банки' || office.bank === bank), [regionalPayload?.offices, bank]);
  const offices = useMemo(
    () =>
      (data?.offices || []).filter(
        (o) => bank === "Все банки" || o.bank === bank,
      ),
    [data?.offices, bank],
  );
  const visibleOffices=useMemo(()=>officeStackIds.length?(regionalPayload?.offices||[]).filter(o=>officeStackIds.includes(o.id)):offices,[regionalPayload?.offices,officeStackIds,offices]);
  const selectedSignal =
    selection?.type === "signal"
      ? combinedSignals.find((s) => s.id === selection.id)
      : null;
  const {detail:selectedSignalDetail,loading:selectedSignalLoading}=useLiveSignalDetail(selection?.type==='signal'?selection.id:null,selectedSignal??null);
  const selectedOffice =
    selection?.type === "office"
      ? SBER_HEAD_OFFICES.find(o=>o.id===selection.id)||regionalPayload?.offices.find((o) => o.id === selection.id)
      : null;
  const selectedLandmark =
    selection?.type === "landmark"
      ? LANDMARKS.find((l) => l.id === selection.id)
      : null;
  const searchResults = territories
    .filter((t) =>
      `${t.name} ${t.oktmo || ""}`.toLowerCase().includes(query.toLowerCase()),
    )
    .slice(0, 30);
  const atRegion = territoryId === "RU-TA";
  const scopeNote =
    snapshot === "current"
      ? "Портфель ГОСБ 8610 · последний срез"
      : "История организаций по ИНН. Принадлежность к ГОСБ на дату среза не установлена.";
  function cardHeader(title: string, sub: string) {
    return (
      <>
        <Back onClick={() => setSelection(null)}>{viewNames[view]}</Back>
        <p className="eyebrow">{sub}</p>
        <h2 className="detail-title">{title}</h2>
      </>
    );
  }
  const toggleMapMode=()=>{
    const next=nextMapMode(is3D,mapStatus.pitch??0,mapStatus.zoom);
    set3D(next.next3D);
    setFocus(previous=>({
      coordinates:mapStatus.center||previous?.coordinates||[51,55.35],
      zoom:mapStatus.zoom,
      pitch:next.pitch,
      bearing:mapStatus.bearing??0,
      nonce:Date.now(),
    }));
  };
  return (
    <main
      data-camera-territory={territoryId}
      data-map-zoom={mapStatus.zoom}
      data-map-center={mapStatus.center?.join(",")}
      data-map-bbox={mapStatus.bbox?.join(",")}
      className={`atlas map-first ${contextVisible ? "panel-open" : "panel-closed"} ${expanded ? "sheet-expanded" : ""} ${!mapStatus.webgl ? "list-mode" : ""}`}
    >
      <div className="map-surface">
        <AtlasMap
          selectedSignalId={selection?.type==='signal'?selection.id:null}
          highlightedSignalId={hoveredSignalId}
          highlightedTerritoryId={signalTerritoryContextId}
          unreadSignalIds={attentionSignalIds}
          recentSignalIds={liveFeed.recentIds}
          territories={territories}
          signals={otherRegion ? [] : mapSignals}
          offices={otherRegion ? [] : mapOffices}
          territoryId={territoryId}
          focus={focus}
          layers={mapLayers}
          is3D={is3D}
          appearance={appearance}
          panelOpen={contextVisible}
          bankFocus={contextVisible && view === "banks" && perspective!=="sber"}
          clients={mode==='work'?clientMapData?.items:[]}
          clientsVisible={mode==='work'&&(perspective==='sber'||view==='organizations')}
          onClient={openClient}
          onClientStack={ids => { setClientStackIds(ids); setClientStackLimit(40); setSelection(null); setView('organizations'); setPanelOpen(true); setOverlay(null); }}
          route={routeFeatures}
          focusedOrganization={focusedOrganization}
          cameraScopeEnabled={!otherRegion}
          onCameraTerritory={(id) => { setTerritoryId(id); setSignalTerritoryContextId(id==='RU-TA'?null:id); setOtherRegion(null); }}
          onHoverTerritory={(id)=>{setSignalTerritoryContextId(id);setSignalLimit(40);}}
          onTerritory={chooseTerritory}
          onRegion={(id, name, coordinates) => {
            setOverlay(null);
            if (id === "RU-TA") {
              chooseTerritory("RU-TA");
              return;
            }
            setOtherRegion({ id, name });
            setSelection(null);
            setPanelOpen(true);
            fly(coordinates, 5, 0);
          }}
          onSignal={chooseSignal}
          onSignalStack={(ids)=>{setOverlay(null);setSignalStackIds(ids);setSelection(null);setView('signals');setPanelOpen(true);setExpanded(true);}}
          onSignalGroup={(id) => {
            setOverlay(null);
            setOtherRegion(null);
            setTerritoryId(id);
            setSignalTerritoryContextId(id);
            setSelection(null);
            setView("signals");
            setCategory("Все");
            setSignalLimit(40);
            setPanelOpen(true);
            setExpanded(true);
            if (id !== territoryId) {
              setSignalIds([]);
              setOrganizationIds([]);
            }
          }}
          onOffice={chooseOffice}
          onOfficeStack={ids=>{setOfficeStackIds(ids);setSelection(null);setOverlay(null);setView("banks");setPanelOpen(true);setExpanded(true);setBankLimit(40);}}
          onLandmark={chooseLandmark}
          onBuilding={(building) => {
            setOverlay(null);
            setSelection({ type: "building", id: building.id, building });
            setView("places");
            setExpanded(true);
            setPanelOpen(true);
          }}
          onStatus={onMapStatus}
        />
      </div>
      <header className="topbar glass">
        <a
          className="brand"
          href={`/?mode=${mode}`}
          aria-label="Сбер Атлас — начало"
        >
          <span className="brand-mark">
            <Check size={20} />
          </span>
          <span>
            Сбер <b>Атлас</b>
          </span>
          <span className="pilot-badge">Пилот</span>
        </a>
        <button
          className="search-trigger"
          aria-label="Найти на карте"
          onClick={() => setShowSearch(true)}
        >
          <Search size={17} />
          <span>Найти на карте</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="top-actions">
          <SceneClock appearance={appearance} onChange={value => setAppearance({ ...value, life: true })} />
          <IconButton
            label="Источники и импорт"
            onClick={() => setShowSources(true)}
          >
            <Database size={18} />
          </IconButton>
        </div>
        <IconButton
          label="Поиск"
          className="mobile-search"
          onClick={() => setShowSearch(true)}
        >
          <Search size={19} />
        </IconButton>
      </header>
      <div className="place-heading">
        <button
          className="region-back"
          onClick={() => {
            chooseTerritory("RU-TA");
            fly([83, 62], 2.7, 0);
          }}
        >
          <Globe2 size={13} />
          Россия <ChevronRight size={12} />
        </button>
        <button className="place-name" aria-label="Аналитика текущей территории" onClick={() => setOverlay("analytics")}>
          {otherRegion?.name ||
            (atRegion ? "Татарстан" : territory?.name || "Татарстан")}
          <ChevronDown size={18} />
        </button>
        <p>
          {atRegion
            ? "Цифровой атлас территории"
            : kindNames[territory?.kind || ""] || "Территория"}{" "}
          <span>·</span>{" "}
          {mode === "work" ? "Для подготовки встреч" : "Публичные источники"}
        </p>
      </div>
      {(!online || mapStatus.networkError) && (
        <div className="network-banner" role="status">
          {!online
            ? "Нет подключения к сети"
            : "Подложка загружается с перебоями"}
          . Локальные данные доступны.
          <button onClick={() => setRefresh((x) => x + 1)}>Повторить</button>
        </div>
      )}
      {!mapStatus.webgl && (
        <div className="webgl-note">
          <Map size={28} />
          <h2>Карта недоступна в этом браузере</h2>
          <p>Территории, сигналы и досье доступны в списке.</p>
          <button className="secondary" onClick={() => setShowSearch(true)}>
            Выбрать территорию
          </button>
        </div>
      )}
      {contextVisible && (
        <aside className="context-panel glass" aria-label="Данные территории">
          <button
            className="sheet-handle"
            aria-label={expanded ? "Свернуть карточку" : "Развернуть карточку"}
            onClick={() => setExpanded(!expanded)}
          >
            <span />
            {expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
          <div className="panel-heading">
            <div>
              <h2>{selection ? ({signal:'Сигнал',organization:'Организация',office:'Банк',landmark:'Место',building:'Здание'}[selection.type]) : viewNames[view]}</h2>
            </div>
            {mode === "work" && ['overview','organizations','banks'].includes(view) ? (
              <select
                aria-label="Срез предложений"
                value={snapshot}
                onChange={(e) => setSnapshot(e.target.value)}
              >
                {SNAPSHOTS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            ) : mode === 'public' ? (
              <span className="tag neutral">Публичный срез</span>
            ) : null}
            <IconButton
              label={selection ? "Закрыть карточку" : "Закрыть панель"}
              onClick={() => { setHoveredSignalId(null); setSelection(null); setPanelOpen(false); }}
            >
              <X size={18} />
            </IconButton>
          </div>
          <div
            className="panel-scroll"
            key={`${selection?.type || view}:${selection?.id || territoryId}`}
          >
            {otherRegion ? (
              <Empty>
                <Globe2 size={28} />
                <h3>{otherRegion.name}</h3>
                <p>
                  Обзорный контур региона. Подробные данные и муниципальная
                  иерархия в пилоте подключены для Татарстана.
                </p>
                <p className="caption">
                  Исторический срез границ OSM. Современная полнота справочника
                  России не заявлена.
                </p>
                <button
                  className="primary"
                  onClick={() => chooseTerritory("RU-TA")}
                >
                  Открыть Татарстан
                </button>
              </Empty>
            ) : loading && !data ? (
              <div className="loading-row">
                <span className="spinner" />
                Загружаем данные…
              </div>
            ) : error ? (
              <Empty>
                <p role="alert">{error}</p>
                <button
                  className="secondary"
                  onClick={() => setRefresh((x) => x + 1)}
                >
                  Повторить
                </button>
              </Empty>
            ) : (
              <>
                {selection?.type==='signal' && selectedSignalDetail ? (
                  <>
                    <Back onClick={()=>setSelection(null)}>Сигналы</Back>
                    {selectedSignalLoading&&<p className="live-detail-loading" role="status">Обновляем историю и источники…</p>}
                    <SignalDetail signal={selectedSignalDetail} asOf={asOf} newsDays={liveDays} onCategory={(name)=>{setCategory(categoryName(selectedSignalDetail.category));setSubCategory(name);setSelection(null);setView('signals');}}/>
                    {mode==='work'&&selectedSignalDetail.live&&<SignalRelevance signalId={selectedSignalDetail.id} snapshot={snapshot} onOrganization={(id)=>{setSelection({type:'organization',id});setView('organizations');setExpanded(true);setPanelOpen(true);}} onPlan={(id)=>{setPlanningOrgId(id);setShowPlanning(true);}}/>}
                    <button
                      className="primary full"
                      onClick={() => toggleSignal(selectedSignalDetail.id)}
                    >
                      {signalIds.includes(selectedSignalDetail.id) ? (
                        <Check size={16} />
                      ) : (
                        <Plus size={16} />
                      )}{" "}
                      {signalIds.includes(selectedSignalDetail.id)
                        ? "В повестке встречи"
                        : "Добавить в повестку"}
                    </button>
                  </>
                ) : selection?.type === "organization" ? (
                  orgDetail ? (
                    <>
                      {cardHeader(orgDetail.name, "Организация")}
                      <div className="tag-row">
                        <span className="tag neutral">ИНН {orgDetail.inn}</span>
                        <span className="tag neutral">
                          ГОСБ {orgDetail.gosb}
                        </span>
                      </div>
                      <p className="notice">
                        {orgDetail.location?.meeting?.address ||
                          orgDetail.location?.office?.address ||
                          "Адрес места встречи пока не подтверждён."}{" "}
                        Показатели организации не распределяются по
                        муниципалитетам.
                      </p>
                      <button
                        className="secondary full"
                        onClick={() => {
                          setPlanningOrgId(orgDetail.id);
                          setShowPlanning(true);
                        }}
                      >
                        <Route size={16} />
                        Адрес, возможности и план встречи
                      </button>
                      <h3 className="section-title">
                        ФОТ <small>в рублях</small>
                      </h3>
                      <div className="comparison">
                        <span />
                        <span>Март</span>
                        <span>Июль</span>
                        <strong>Объём</strong>
                        <b>{money(orgDetail.payroll?.fot_march)}</b>
                        <b>{money(orgDetail.payroll?.fot_july)}</b>
                        <strong>Получатели</strong>
                        <b>{number(orgDetail.payroll?.recipients_march)}</b>
                        <b>{number(orgDetail.payroll?.recipients_july)}</b>
                      </div>
                      {orgDetail.payroll?.fot_march != null &&
                        orgDetail.payroll.fot_july != null && (
                          <p className="caption">
                            Изменение ФОТ:{" "}
                            {money(
                              orgDetail.payroll.fot_july -
                                orgDetail.payroll.fot_march,
                            )}
                            . Рост ФОТ — повод уточнить потребности, а не
                            подтверждённая возможность продажи.
                          </p>
                        )}
                      <h3 className="section-title">Встречи по отчёту</h3>
                      <p className="metric-inline">
                        {orgDetail.meetings?.conflict
                          ? "Конфликт исходных счётчиков"
                          : `${number(orgDetail.meetings?.q1)} / ${number(orgDetail.meetings?.q2)} / ${number(orgDetail.meetings?.q3)}`}
                      </p>
                      <p className="caption">
                        I / II / III кварталы. Уникальность отдельных событий не
                        подтверждена.
                      </p>
                      <h3 className="section-title">
                        Предложения <span>{orgDetail.offerCount}</span>
                      </h3>
                      <p className="caption">{scopeNote}</p>
                      {orgDetail.offerSource && (
                        <p className="caption">
                          {orgDetail.offerSource.label}
                          {orgDetail.offerSource.dateInferred
                            ? " · дата определена по имени файла"
                            : ""}
                        </p>
                      )}
                      {orgDetail.offerChanges && (
                        <section className="evidence">
                          <h3>Изменения между срезами</h3>
                          {orgDetail.offerChanges.comparable && (
                            <>
                              <p>
                                Новых: {number(orgDetail.offerChanges.added)} ·
                                Выбывших:{" "}
                                {number(orgDetail.offerChanges.removed)} ·
                                Изменённых:{" "}
                                {number(orgDetail.offerChanges.changed)}
                              </p>
                              <p>
                                Изменение ожидаемого дохода:{" "}
                                {money(orgDetail.offerChanges.incomeDelta)}
                              </p>
                            </>
                          )}
                          <p className="caption">
                            {orgDetail.offerChanges.note}
                          </p>
                        </section>
                      )}
                      {orgDetail.offers?.map((o) => (
                        <div className="offer-row" key={o.id}>
                          <strong>{o.product || "Продукт не указан"}</strong>
                          <p>{o.stage || "Этап не указан"}</p>
                          <small>
                            ОД {money(o.expected_income)} · #{o.offer_id}
                          </small>
                        </div>
                      ))}
                      <button
                        className="primary full"
                        onClick={() => toggleOrg(orgDetail.id)}
                      >
                        {organizationIds.includes(orgDetail.id) ? (
                          <Check size={16} />
                        ) : (
                          <Plus size={16} />
                        )}{" "}
                        {organizationIds.includes(orgDetail.id)
                          ? "Организация в повестке"
                          : "Добавить в повестку"}
                      </button>
                    </>
                  ) : (
                    <div className="loading-row">
                      <span className="spinner" />
                      Открываем организацию…
                    </div>
                  )
                ) : selection?.type === "building" ? (
                  <>
                    {cardHeader("Здание", "Застройка Татарстана")}
                    <div className="model-spec">
                      <span>Высота</span>
                      <strong>{number(selection.building.height)} м</strong>
                      <span>Основание</span>
                      <strong>
                        {selection.building.estimated
                          ? "Оценка"
                          : "Исходные данные"}
                      </strong>
                      <span>Этажей в источнике</span>
                      <strong>{number(selection.building.floors)}</strong>
                    </div>
                    <p className="notice">
                      {selection.building.estimated
                        ? "Высота рассчитана по числу этажей × 3 м. Если этажность отсутствует, показана условная высота 8 м."
                        : "Высота указана в открытом источнике; натурная проверка не проводилась."}
                    </p>
                    <p className="caption">
                      Контур Overture. Адрес и организации в этом здании не
                      подтверждены.
                    </p>
                    <Source url="https://docs.overturemaps.org/schema/reference/buildings/building/">
                      Схема и происхождение зданий
                    </Source>
                  </>
                ) : selectedOffice ? (
                  <>
                    {cardHeader(
                      selectedOffice.name,
                      sberOfficeRole(selectedOffice)?`Сбер · ${sberOfficeRole(selectedOffice)}`:bankName(selectedOffice.bank),
                    )}
                    <p className="detail-summary">
                      {selectedOffice.address || "Адрес не указан"}
                    </p>
                    <p className="notice">
                      {selectedOffice.coordinates
                        ? "Координаты объекта из OpenStreetMap."
                        : "Точная геопривязка отсутствует; запись доступна в списке."}
                    </p>
                    <Source url={selectedOffice.sourceUrl}>
                      Источник подразделения
                    </Source>
                    <Source url={selectedOffice.coordinateSourceUrl}>
                      Источник координат
                    </Source>
                    <p className="caption">
                      Проверка: {shortDate(selectedOffice.checkedAt)}. Режим
                      работы и доступность услуг уточняются отдельно.
                    </p>
                    {selectedOffice.coordinates && (
                      <button
                        className="secondary full"
                        onClick={() => fly(selectedOffice.coordinates!,sberOfficeRole(selectedOffice)==='ТБ'?6.4:17,sberOfficeRole(selectedOffice)==='ТБ'?0:50)}
                      >
                        <LocateFixed size={17} />
                        Показать на карте
                      </button>
                    )}
                  </>
                ) : selectedLandmark ? (
                  <>
                    {cardHeader(
                      selectedLandmark.name,
                      "Архитектура Татарстана",
                    )}
                    <p className="detail-summary">
                      {selectedLandmark.description}
                    </p>
                    <div className="model-spec">
                      <span>Высота модели</span>
                      <strong>{selectedLandmark.height} м</strong>
                      <span>Детализация</span>
                      <strong>Автоматическая</strong>
                    </div>
                    <p className="caption">
                      Авторская объёмная модель с приблизительными пропорциями.
                      Положение здания подтверждено по OSM.
                    </p>
                    <Source url={selectedLandmark.sourceUrl}>
                      Контур и положение
                    </Source>
                    <Source url={selectedLandmark.referenceUrl}>
                      Об объекте
                    </Source>
                    <button
                      className="secondary full"
                      onClick={() =>
                        fly(
                          selectedLandmark.coordinates as Coordinates,
                          18.1,
                          65,
                          80,
                        )
                      }
                    >
                      <Compass size={17} />
                      Другой ракурс
                    </button>
                  </>
                ) : view === "overview" ? (
                  <>
                    <div className="overview-lead">
                      <span className="live-dot" />
                      <span>
                        {atRegion
                          ? "956 муниципалитетов"
                          : "Муниципальная навигация"}
                      </span>
                      <button
                        className="text-button"
                        onClick={() => setShowSearch(true)}
                      >
                        Открыть <ChevronRight size={13} />
                      </button>
                    </div>
                    <h3 className="pulse-title">
                      Что происходит
                      <br />
                      на территории
                    </h3>
                    <div className="summary-strip">
                      <button onClick={() => changeView("signals")}>
                        <strong>
                          {number(signals.length)}
                        </strong>
                        <span>
                          сигналов на карте
                        </span>
                      </button>
                      <button onClick={() => changeView("banks")}>
                        <strong>
                          {number(
                            data?.offices.filter((o) => o.coordinates).length,
                          )}
                        </strong>
                        <span>точек банков из OSM</span>
                      </button>
                    </div>
                    <div className="section-line">
                      <h3>В фокусе</h3>
                      <button
                        className="text-button"
                        onClick={() => changeView("signals")}
                      >
                        Все сигналы <ChevronRight size={13} />
                      </button>
                    </div>
                    {signals.slice(0, 3).map((s) => (
                      <SignalRow
                        key={s.id}
                        signal={s}
                        onClick={() => chooseSignal(s.id)}
                        attention={liveFeed.unreadIds.includes(s.id)?'unread':liveFeed.recentIds.includes(s.id)?'recent':'none'}
                      />
                    ))}
                    {mode === "work" && atRegion && (
                      <div className="portfolio-summary">
                        <div className="section-line">
                          <h3>Работа с клиентами</h3>
                          <BriefcaseBusiness size={16} />
                        </div>
                        <p className="caption">{scopeNote}</p>
                        <div className="portfolio-line">
                          <span>Предложений</span>
                          <b>{number(data?.summary.offers)}</b>
                        </div>
                        <div className="portfolio-line">
                          <span>Ожидаемый доход</span>
                          <b>{money(data?.summary.expectedIncome)}</b>
                        </div>
                        <div className="portfolio-line">
                          <span>Встречи по отчёту</span>
                          <b>
                            {data?.summary.meetings?.map(number).join(" / ") ||
                              "Нет данных"}
                          </b>
                        </div>
                        <button
                          className="text-button"
                          onClick={() => changeView("organizations")}
                        >
                          Перейти к организациям <ArrowUpRight size={14} />
                        </button>
                      </div>
                    )}
                    {territory && (
                      <div className="territory-children">
                        <h3 className="section-title">
                          {atRegion
                            ? "Районы и городские округа"
                            : "В составе территории"}
                        </h3>
                        {territories
                          .filter((t) => t.parentId === territoryId)
                          .map((t) => (
                            <button
                              className="compact-row"
                              key={t.id}
                              onClick={() => chooseTerritory(t.id)}
                            >
                              <span>
                                {t.name}
                                <small>
                                  {kindNames[t.kind]}
                                  {t.geometryStatus !== "verified"
                                    ? " · Нет полигона"
                                    : ""}
                                </small>
                              </span>
                              <ChevronRight size={14} />
                            </button>
                          ))}
                      </div>
                    )}
                  </>
                ) : view === "signals" ? (
                  <>
                    <div className="signal-scope">
                      <span>{newBatchIds.length?`Новые сигналы · ${visibleSignalCards.length}`:signalTerritoryContext?<><strong>{signalTerritoryContext.name}</strong> сначала · {localSignalCount} из {signals.length}</>:<>Республика Татарстан · {signals.length}{" "}
                      {signals.length % 100 >= 11 && signals.length % 100 <= 14
                        ? "сигналов"
                        : signals.length % 10 === 1
                          ? "сигнал"
                          : signals.length % 10 >= 2 && signals.length % 10 <= 4
                            ? "сигнала"
                            : "сигналов"}</>}</span>
                      <button onClick={()=>{setSignalTerritoryContextId(null);setTerritoryId('RU-TA');fly([51,55.35],6.35,0);}}><Map size={13}/>{signalTerritoryContext?'Все по республике':'Вся карта'}</button>
                    </div>
                    {newBatchIds.length>0&&<button className="signal-show-all" onClick={()=>{setNewBatchIds([]);setSignalQuality('useful');}}>Показать все важные сигналы</button>}
                    {signalStackIds.length>1&&<section className="live-signal-stack"><div><strong>Несколько сигналов в одной точке</strong><button onClick={()=>setSignalStackIds([])}>Закрыть</button></div>{signalStackIds.map(id=>combinedSignals.find(item=>item.id===id)).filter((item):item is Signal=>Boolean(item)).map(item=><SignalRow key={item.id} signal={item} onClick={()=>chooseSignal(item.id)} selected={signalIds.includes(item.id)} attention={liveFeed.unreadIds.includes(item.id)?'unread':liveFeed.recentIds.includes(item.id)?'recent':'none'}/>)}</section>}
                    <div className="signal-toolbar"><div className="filter-chips" aria-label="Отбор публикаций"><button className={signalQuality==='useful'?'selected':''} aria-pressed={signalQuality==='useful'} onClick={()=>{setSignalQuality('useful');setSignalLimit(40);}}>Важное</button><button className={signalQuality==='all'?'selected':''} aria-pressed={signalQuality==='all'} onClick={()=>{setSignalQuality('all');setSignalLimit(40);}}>Все публикации</button></div><label className="signal-sort">Сортировка<select aria-label="Сортировка сигналов" value={signalSort} onChange={e=>setSignalSort(e.target.value as typeof signalSort)}><option value="relevance">По релевантности</option><option value="significance">По значимости</option><option value="date">По дате</option></select></label></div>
                    <details className="signal-status-legend"><summary>Обозначения статусов</summary><p>Маркер кратко показывает тему, затем — статус. Цвет и значок статуса совпадают с легендой.</p><div>{SIGNAL_STATUS_LEGEND.map(item=><span key={item.state}><i style={{background:item.color}}><SignalCategoryIcon icon={item.icon}/></i><b>{item.label}</b></span>)}</div></details>
                    <details className="signal-filter-settings signal-filter-compact"><summary><SlidersHorizontal size={14}/>Фильтры <span>{signalState==='all'&&category==='Все'&&!residentReports?'по умолчанию':'изменены'}</span></summary><div className="signal-topic-filters"><label className="field">Этап<select aria-label="Этап сигнала" value={signalState} onChange={e=>{const flow=e.target.value as SignalFlow;setNewBatchIds([]);setSignalState(flow);setSignalPeriod(flow==='results'?'resolved':'current');setSignalLimit(40);setSignalStackIds([]);}}>{[['all','Все сигналы'],['complaints','Жалобы и проблемы'],['work','Работы и планы'],['results','Готово / результат']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label className="field">Тема<select aria-label="Группа тем" value={category} onChange={e=>{setNewBatchIds([]);setCategory(e.target.value);setSubCategory('Все категории');setSignalLimit(40);}}>{['Все',...new Set(combinedSignals.filter(s=>!hasTatarScript(s)).map(s=>categoryName(s.category)))].map(name=><option key={name} value={name}>{name==='Все'?'Все темы':name}</option>)}</select></label></div><label className="signal-resident-toggle"><input type="checkbox" checked={residentReports} onChange={e=>setResidentReports(e.target.checked)}/>Архив обращений жителей</label></details>
                    {visibleSignalCards.length ? (
                      visibleSignalCards.slice(0,signalLimit).map(({primary:s,locations})=>{const unread=locations.find(item=>attentionSignalIds.includes(item.id));const row=unread||s;return <div className="signal-publication" key={s.id}><SignalRow signal={locations.length>1?{...row,title:row.title.split(/\s+—\s+/)[0]}:row} onClick={()=>chooseSignal(row.id)} onHover={setHoveredSignalId} selected={signalIds.includes(row.id)} attention={unread?'unread':liveFeed.recentIds.includes(row.id)?'recent':'none'}/>{locations.length>1&&<details className="signal-publication-locations"><summary>Места события · {locations.length}</summary>{locations.map(location=><button key={location.id} onMouseEnter={()=>setHoveredSignalId(location.id)} onMouseLeave={()=>setHoveredSignalId(null)} onFocus={()=>setHoveredSignalId(location.id)} onBlur={()=>setHoveredSignalId(null)} onClick={()=>chooseSignal(location.id)}><MapPin size={13}/>{location.address||location.title.split(' — ').at(-1)}{attentionSignalIds.includes(location.id)&&<span className="signal-new-inline">Новый</span>}</button>)}</details>}</div>})
                    ) : (
                      <Empty>
                        Для выбранной темы пока нет сигналов в загруженной ленте.
                      </Empty>
                    )}
                    {visibleSignalCards.length > signalLimit && (
                      <button
                        className="secondary full"
                        onClick={() => setSignalLimit((n) => n + 40)}
                      >
                        Показать ещё · {visibleSignalCards.length - signalLimit}
                      </button>
                    )}
                    {liveFeed.hasMore&&<button className="secondary full" disabled={liveFeed.loading} onClick={()=>void liveFeed.loadMore()}>{liveFeed.loading?'Загружаем…':`Загрузить ещё из live-ленты · ${Math.max(0,liveFeed.total-liveFeed.signals.length)}`}</button>}
                  </>
                ) : view === "organizations" ? (
                  mode === "public" ? (
                    <Empty>
                      <ShieldCheck size={28} />
                      <h3>Публичная презентация</h3>
                      <p>Внутренний портфель доступен в рабочем режиме.</p>
                      <button className="secondary" onClick={switchMode}>
                        Включить рабочий режим
                      </button>
                    </Empty>
                  ) : (
                    <>
                      {clientMapError && <p role="alert" className="notice">{clientMapError}</p>}
                      {clientStackIds.length > 0 && <section className="live-signal-stack" aria-label="Клиенты в группе">
                        <div><strong>Клиенты в этой группе · {clientStackIds.length}</strong><button onClick={() => setClientStackIds([])}>Закрыть группу</button></div>
                        <p className="caption">Совпадающие адреса не объединяют клиентов. Каждая карточка доступна отдельно.</p>
                        {clientStackIds.slice(0, clientStackLimit).map(id => <button className="organization-row" key={id} onClick={() => openClient(id)}><span><strong>{clientMapData?.items.find(p => p.id === id)?.name || id}</strong><small>{clientMapData?.items.find(p => p.id === id)?.inn}</small></span><ChevronRight size={16}/></button>)}
                        {clientStackLimit < clientStackIds.length && <button className="secondary" onClick={() => setClientStackLimit(n => n + 40)}>Показать ещё</button>}
                      </section>}
                      <ClientPortfolio snapshot={snapshot} territoryId={territoryId} territoryName={territory?.name || 'Татарстан'} refresh={refresh}
                        onOpen={openClient} onPlan={planClient} onMap={point => { openClient(point.id); fly(point.coordinates, 16.4, is3D ? 58 : 0); }}
                        onImported={refreshClients} onFilter={setPortfolioFilter} onSources={() => setShowSources(true)} onSignal={chooseSignal}/>
                    </>
                  )
                ) : view === "banks" ? (
                  <>
                    {officeStackIds.length>0&&<section className="live-signal-stack"><div><strong>Банковские объекты в группе · {officeStackIds.length}</strong><button onClick={()=>setOfficeStackIds([])}>Все объекты</button></div><p className="caption">{[...new Set((data?.offices||[]).filter(o=>officeStackIds.includes(o.id)).map(o=>o.bank))].map(b=>bankName(b)+': '+(data?.offices||[]).filter(o=>officeStackIds.includes(o.id)&&o.bank===b).length).join(' · ')}</p></section>}
                    {!officeStackIds.length&&<SberWorkspace clients={mode==='work'?clientMapData:null} signals={mapSignals} onOffice={chooseOffice} onSignal={chooseSignal} onClients={()=>{setView('organizations');setPerspective('sber');}}/>}
                    {!officeStackIds.length&&<BankPriorities priorities={priorities} currentTerritoryId={territoryId} onTerritory={id=>{chooseTerritory(id);setView("banks");}}/>}
                    <label className="field compact">
                      Банк
                      <select
                        value={bank}
                        onChange={(e) => {setBank(e.target.value);setOfficeStackIds([]);}}
                      >
                        <option>Все банки</option>
                        {[...new Set(data?.offices.map((o) => o.bank) || [])]
                          .sort()
                          .map((b) => (
                            <option key={b} value={b}>
                              {bankName(b)}
                            </option>
                          ))}
                      </select>
                    </label>
                    <p className="notice">
                      Реестр ЦБ и объекты OSM могут пересекаться. Список не
                      является числом уникальных действующих офисов. На карте —
                      только записи с координатами.
                    </p>
                    {visibleOffices.slice(0, bankLimit).map((o) => (
                      <button
                        className="list-row bank-row"
                        key={o.id}
                        onClick={() => {
                          chooseOffice(o.id);
                        }}
                      >
                        <span
                          className={`bank-icon ${o.bank === "sber" ? "sber" : ""}`}
                        >
                          <Building2 size={18} />
                        </span>
                        <span>
                          <strong>{bankName(o.bank)}</strong>
                          <small>{o.address || o.name}</small>
                          <em>
                            {o.coordinates
                              ? "Объект на карте"
                              : "Без координат"}
                          </em>
                        </span>
                        <ChevronRight size={14} />
                      </button>
                    ))}
                    {visibleOffices.length > bankLimit && (
                      <button
                        className="secondary full"
                        onClick={() => setBankLimit((n) => n + 40)}
                      >
                        Показать ещё · {visibleOffices.length - bankLimit}
                      </button>
                    )}
                  </>
                ) : view === "places" ? (
                  <>
                    <p className="muted">
                      Восемь архитектурных акцентов. При приближении открываются
                      фасады и детали.
                    </p>
                    {LANDMARKS.map((l, i) => (
                      <button
                        className="place-row"
                        key={l.id}
                        onClick={() => chooseLandmark(l.id)}
                      >
                        <span className="place-number">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span>
                          <strong>{l.name}</strong>
                          <small>{l.subtitle}</small>
                        </span>
                        <ArrowUpRight size={16} />
                      </button>
                    ))}
                  </>
                ) : null}
              </>
            )}
          </div>
          <div className="panel-footer">
            <button
              className="primary full"
              onClick={() => setShowDossiers(true)}
            >
              <FileText size={17} />
              Досье встречи
              {signalIds.length + organizationIds.length > 0 && (
                <span className="count-badge">
                  {signalIds.length + organizationIds.length}
                </span>
              )}
            </button>
            <p>
              <span className="local-dot" />
              {mode === "work"
                ? "Данные хранятся локально"
                : "Только публичные данные"}
            </p>
          </div>
        </aside>
      )}
      <div className="map-controls glass">
        <IconButton
          label="Приблизить"
          onClick={() =>
            setFocus((f) => ({
              coordinates: mapStatus.center || f?.coordinates || [51, 55.35],
              zoom: Math.min(20, mapStatus.zoom + 1),
              pitch: is3D ? (mapStatus.pitch ?? 50) : 0,
              bearing: mapStatus.bearing ?? 0,
              nonce: Date.now(),
            }))
          }
        >
          <Plus size={19} />
        </IconButton>
        <IconButton
          label="Отдалить"
          onClick={() =>
            setFocus((f) => ({
              coordinates: mapStatus.center || f?.coordinates || [51, 55.35],
              zoom: Math.max(2, mapStatus.zoom - 1),
              pitch: is3D ? (mapStatus.pitch ?? 50) : 0,
              bearing: mapStatus.bearing ?? 0,
              nonce: Date.now(),
            }))
          }
        >
          <Minus size={19} />
        </IconButton>
        <span className="control-divider" />
        <IconButton
          label="Север сверху"
          onClick={() =>
            setFocus((f) => ({
              coordinates: mapStatus.center || f?.coordinates || [51, 55.35],
              zoom: mapStatus.zoom,
              pitch: is3D ? (mapStatus.pitch ?? 50) : 0,
              bearing: 0,
              nonce: Date.now(),
            }))
          }
        >
          <Compass size={19} />
        </IconButton>
        <IconButton
          label={is3D ? "Перейти в 2D" : "Перейти в 3D"}
          aria-pressed={is3D}
          data-map-mode={is3D ? "3d" : "2d"}
          onClick={toggleMapMode}
        >
          <b>{is3D ? "3D" : "2D"}</b>
        </IconButton>
        <IconButton
          label="Вернуться к Татарстану"
          onClick={() => chooseTerritory("RU-TA")}
        >
          <LocateFixed size={19} />
        </IconButton>
      </div>
      {!otherRegion&&!(contextVisible&&view==='signals')&&<LiveSignalStatus worker={liveFeed.worker} error={liveFeed.error} loading={liveFeed.loading} newCount={visibleUnreadIds.length} onNew={openNewestUnread} onRetry={liveFeed.reconnect}/>}
      <div className="map-legend glass">
        <span className="legend-signal">●</span>
        <span>
          {mapStatus.zoom < 10
            ? "Число сигналов · агрегат территории"
            : mapStatus.zoom < 16
              ? "Темы территории · точные объекты банков"
              : "Объекты · объёмная архитектура"}
        </span>
        <button
          onClick={() => setShowSources(true)}
          aria-label="Точность данных"
        >
          <SlidersHorizontal size={13} />
        </button>
      </div>
      {exploreOpen && <MapMenu layers={layers} perspective={perspective} onPerspective={setPerspective} onSources={()=>setShowSources(true)} pitch={Math.round(mapStatus.pitch??30)} onClose={()=>setExploreOpen(false)} onToggle={(key,value)=>{setLayers(l=>({...l,[key]:value}));setView('overview');setPanelOpen(false);}} onFocus={v=>{setLayers(l=>({...l,signals:v==='signals',banks:v==='banks',landmarks:v==='places'}));changeView(v);}} onAll={()=>{setLayers(l=>({...l,signals:true,banks:true,landmarks:true}));setView('overview');setSelection(null);setPanelOpen(false);setExploreOpen(false);}} onPitch={pitch=>{set3D(true);fly(mapStatus.center||[51,55.35],mapStatus.zoom,pitch,mapStatus.bearing??0);}} onTour={startTour}/>}
      <nav className="bottom-dock glass" aria-label="Главная навигация">
        <button
          aria-expanded={exploreOpen}
          className={exploreOpen ? "active" : ""}
          onClick={() => setExploreOpen(!exploreOpen)}
        >
          <Map size={19} />
          <span>Карта</span>
          <ChevronUp size={13} />
        </button>
        <button aria-pressed={overlay === 'analytics'} onClick={() => setOverlay('analytics')}>
          <BarChart3 size={19}/><span>Аналитика</span>
        </button>
        <button onClick={() => setShowPlanning(true)}>
          <Route size={19} />
          <span>Встречи</span>
        </button>
        <IconButton label="Досье встречи" onClick={() => setShowDossiers(true)}>
          <FileText size={19} />
          {signalIds.length + organizationIds.length > 0 && (
            <span className="count-badge">
              {signalIds.length + organizationIds.length}
            </span>
          )}
        </IconButton>
      </nav>
      {tour >= 0 && (
        <div className="tour-card glass">
          <span className="tour-index">
            {tour + 1} / {tourSteps.length}
          </span>
          <div>
            <strong>{tourSteps[tour].title}</strong>
            <p>{tourSteps[tour].text}</p>
          </div>
          <IconButton
            label="Предыдущая остановка"
            disabled={!tour}
            onClick={() => tourGo(tour - 1)}
          >
            <ArrowLeft size={18} />
          </IconButton>
          <IconButton
            label="Следующая остановка"
            disabled={tour === tourSteps.length - 1}
            onClick={() => tourGo(tour + 1)}
          >
            <ChevronRight size={19} />
          </IconButton>
          <IconButton label="Закрыть маршрут" onClick={() => setTour(-1)}>
            <X size={17} />
          </IconButton>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {overlay === 'analytics' && <TerritoryAnalytics key={mode} mode={mode} initialTerritory={otherRegion?.id || territoryId} initialTab={perspective === 'sber' ? 'sber' : 'territory'}
        onClose={() => setOverlay(null)} onMap={chooseTerritory} onOrganization={openClient} onPlan={planClient} onSignal={chooseSignal}
        onSources={() => setShowSources(true)} onClients={() => { setOverlay(null); setOtherRegion(null); setSelection(null); setView('organizations'); setPanelOpen(true); setPerspective('sber'); }}/>}
      {showSearch && (
        <Modal title="Найти на карте" onClose={() => setShowSearch(false)} wide>
          <label className="command-search">
            <Search size={21} />
            <input
              autoFocus
              aria-label="Найти территорию, организацию или ИНН"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
              placeholder="Территория, организация или ИНН"
            />
          </label>
          <p className="caption">
            Все 956 муниципалитетов актуального справочника. ОКТМО также
            доступен для поиска.
          </p>
          <h3 className="section-title">Территории</h3>
          {searchResults.map((t) => (
            <button
              key={t.id}
              className="list-row"
              onClick={() => chooseTerritory(t.id)}
            >
              <MapPin size={18} />
              <span>
                <strong>{t.name}</strong>
                <small>
                  {kindNames[t.kind]} · {t.oktmo || "Россия"}
                  {t.geometryStatus !== "verified" ? " · Нет полигона" : ""}
                </small>
              </span>
              <ChevronRight size={15} />
            </button>
          ))}
          {query && mode === "work" && (
            <>
              <h3 className="section-title">
                Организации <span>{number(orgTotal)}</span>
              </h3>
              {organizations.slice(0, 8).map((o) => (
                <button
                  className="list-row"
                  key={o.id}
                  onClick={() => {
                    setShowSearch(false);
                    setView("organizations");
                    setSelection({ type: "organization", id: o.id });
                    setExpanded(true);
                    setPanelOpen(true);
                  }}
                >
                  <Building2 size={18} />
                  <span>
                    <strong>{o.name}</strong>
                    <small>
                      ИНН {o.inn} ·{" "}
                      {o.location?.meeting?.address ||
                        o.location?.office?.address ||
                        "Адрес не подтверждён"}
                    </small>
                  </span>
                </button>
              ))}
            </>
          )}
          {!searchResults.length && !organizations.length && (
            <Empty>Ничего не найдено. Попробуйте часть названия или ИНН.</Empty>
          )}
        </Modal>
      )}
      {showIncidents && mode === "work" && (
        <Modal
          title="Обращения жителей · июль 2026"
          onClose={() => setShowIncidents(false)}
          wide
        >
          <IncidentRecords territoryId={territoryId} />
        </Modal>
      )}
      {showSources && (
        <Modal
          title="Данные и источники"
          onClose={() => {
            setShowSources(false);
            setRefresh((n) => n + 1);
          }}
          wide
        >
          <SourcesPanel mode={mode} />
        </Modal>
      )}
      {showDossiers && (
        <Modal
          title="Подготовка встречи"
          onClose={() => setShowDossiers(false)}
          wide
        >
          <DossierEditor
            mode={mode}
            territoryId={territoryId}
            signalIds={signalIds}
            organizationIds={organizationIds}
            snapshot={snapshot}
            onCreated={() => setToast("Досье сохранено на этом компьютере")}
          />
        </Modal>
      )}
      {routePlan && (
        <button
          className="route-summary glass"
          onClick={() => setShowPlanning(true)}
        >
          <Route size={16} />
          {routePlan.stops.length} встречи ·{" "}
          {number(Math.round(routePlan.totalDistanceKm))} км{" "}
          <span>
            {routePlan.method === "straight-line-estimate"
              ? "оценка"
              : "по дорогам"}
          </span>
        </button>
      )}
      {showPlanning && (
        <Modal
          title="Встречи и возможности"
          onClose={() => {
            setShowPlanning(false);
            setRefresh((n) => n + 1);
          }}
          wide
        >
          <PlanningPanel
            mode={mode}
            snapshot={snapshot}
            initialOrganizationId={planningOrgId}
            onRequestWork={() => {
              switchMode();
              setShowPlanning(true);
            }}
            onOrganization={(id) => {
              setRefresh((n) => n + 1);
              setShowPlanning(false);
              setView("organizations");
              setSelection({ type: "organization", id });
              setPanelOpen(true);
            }}
            onRoute={(plan) => {
              setRoutePlan(plan);
              if (!plan) return;
              setShowPlanning(false);
              setPanelOpen(false);
              if (plan?.stops.length) {
                const coords = plan.stops.map((s) => s.coordinates),
                  lngs = coords.map((c) => c[0]),
                  lats = coords.map((c) => c[1]);
                const span = Math.max(
                  Math.max(...lngs) - Math.min(...lngs),
                  (Math.max(...lats) - Math.min(...lats)) * 1.6,
                  0.012,
                );
                fly(
                  [
                    (Math.max(...lngs) + Math.min(...lngs)) / 2,
                    (Math.max(...lats) + Math.min(...lats)) / 2,
                  ],
                  Math.max(8, Math.min(16, Math.log2(360 / span) - 1.8)),
                  35,
                );
              }
            }}
          />
        </Modal>
      )}
    </main>
  );
}
function SignalRow({
  signal: s,
  onClick,
  selected = false,
  attention = 'none',
  onHover,
}: {
  signal: Signal;
  onClick: () => void;
  selected?: boolean;
  attention?: 'unread'|'recent'|'none';
  onHover?: (id:string|null)=>void;
}) {
  const status=signalStatusPresentation(s);
  const category=isResidentReport(s)?`Обращения · ${number(s.count||1)}`:categoryName(s.category);
  const timestamp=publicationDateTime(s.publishedAt);
  const summary=s.visibility==="private"?s.title.split(": ").slice(1).join(": "):s.summary;
  return (
    <button className={`signal-row ${attention==='unread'?'is-unread':attention==='recent'?'is-recent':''}`} aria-label={`${signalHeadline(s)}. ${status.label}. Опубликовано ${timestamp}`} onClick={onClick} onMouseEnter={()=>onHover?.(s.id)} onMouseLeave={()=>onHover?.(null)} onFocus={()=>onHover?.(s.id)} onBlur={()=>onHover?.(null)}>
      <span
        className="signal-type-icon" style={{background:status.color}}
      >
        {selected ? <Check size={16} /> : <SignalCategoryIcon icon={signalMarker(s).icon}/>}
      </span>
      <span className="signal-copy">
        <span className="signal-row-head">
          <span className="signal-category">{category}</span>
          <span className="signal-state-label" style={{color:status.color,borderColor:`${status.color}38`,background:`${status.color}0d`}}><i style={{background:status.color}}/>{status.label}</span>
        </span>
        <strong>{signalHeadline(s)}</strong>
        {summary&&<small>{summary}</small>}
        <span className="signal-row-foot">
          <span className="signal-published-label">Дата публикации</span>
          <time dateTime={s.publishedAt}><Clock3 size={14}/>{timestamp}</time>
        </span>
      </span>
      <ChevronRight className="signal-row-arrow" size={17} aria-hidden="true" />
    </button>
  );
}
