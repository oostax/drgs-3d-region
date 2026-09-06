"""Real browser verification with synthetic local data only (no external requests)."""
import json
import os
import re
import struct
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('ATLAS_BROWSER_URL', 'http://127.0.0.1:3200')
OUT = Path(os.environ.get('ATLAS_BROWSER_OUTPUT', '/tmp/atlas-analytics-browser'))
FIXTURE = Path(os.environ['ATLAS_ANALYTICS_FIXTURE'])
OUT.mkdir(parents=True, exist_ok=True)
territories = json.loads((FIXTURE / 'public/data/territories.json').read_text())
metadata = json.dumps({'vector_layers': [{'id': 'building', 'fields': {}}, {'id': 'building_part', 'fields': {}}]}).encode()
archive = bytearray(128 + len(metadata)); archive[:7] = b'PMTiles'; archive[7] = 3
for offset, value in [(8,127),(16,1),(24,128),(32,len(metadata)),(40,len(archive)),(56,len(archive))]: struct.pack_into('<Q',archive,offset,value)
for offset,value in [(96,1),(97,1),(98,1),(99,1),(100,10),(101,15),(118,13)]: archive[offset]=value
for offset,value in [(102,-1800000000),(106,-850000000),(110,1800000000),(114,850000000)]: struct.pack_into('<i',archive,offset,value)
archive[128:] = metadata
report = {'fixture': '85 synthetic deal clients, 80 initially mapped, 5 complaints; actual Atlas UI and local API', 'checks': [], 'pageErrors': [], 'mapErrors': [], 'externalRequests': []}

def install_routes(page):
    page.on('pageerror', lambda e: report['pageErrors'].append(str(e)))
    def external(route):
        if urlsplit(route.request.url).hostname not in ('127.0.0.1','localhost'):
            report['externalRequests'].append(route.request.url); route.abort()
        else: route.continue_()
    page.route('**/*', external)
    page.route('**/api/map/style', lambda route: route.fulfill(json={'version':8,'glyphs':BASE+'/__fixture/fonts/{fontstack}/{range}.pbf','sources':{},'layers':[{'id':'background','type':'background','paint':{'background-color':'#bdc6b8'}}]}))
    page.route('**/__fixture/fonts/**', lambda route: route.fulfill(body=b'',content_type='application/x-protobuf'))
    page.route('**/data/tatarstan-boundaries.geojson', lambda route: route.fulfill(json={'type':'FeatureCollection','features':[{'type':'Feature','properties':{'territoryId':t['id'],'kind':t['kind'],'name':t['name']},'geometry':t['geometry']} for t in territories]}))
    def tiles(route):
        value=route.request.headers.get('range',''); match=re.search(r'bytes=(\d+)-(\d*)',value)
        start=int(match[1]) if match else 0; end=min(len(archive)-1,int(match[2]) if match and match[2] else len(archive)-1)
        headers={'content-type':'application/octet-stream','accept-ranges':'bytes'}
        if match: headers['content-range']=f'bytes {start}-{end}/{len(archive)}'
        route.fulfill(status=206 if match else 200,headers=headers,body=bytes(archive[start:end+1]))
    page.route('**/api/tiles/buildings*',tiles)

def ready(page):
    page.wait_for_function('window.__atlasMap && document.querySelector("[data-atlas-ready=true]")',timeout=45000)
    page.evaluate('window.__errors=[]; window.__atlasMap.on("error",e=>window.__errors.push(String(e.error)))')

def check(name):
    report['checks'].append(name);print(name,flush=True)

with sync_playwright() as p:
    executable = os.environ.get('CHROMIUM_PATH')
    browser=p.chromium.launch(headless=True,**({'executable_path':executable} if executable else {}),args=['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    context=browser.new_context(viewport={'width':1440,'height':1000},reduced_motion='reduce')
    page=context.new_page(); install_routes(page)
    try:
        page.goto(BASE+'/?mode=work&diagnostics',wait_until='domcontentloaded');ready(page)
        expect(page.locator('.maplibregl-ctrl-scale')).to_have_count(0);expect(page.locator('.life-status')).to_have_count(0)
        expect(page.get_by_text('Жизнь города',exact=True)).to_have_count(0)
        check('Scale and simulation controls removed')
        camera=page.evaluate('({center:window.__atlasMap.getCenter().toArray(),zoom:window.__atlasMap.getZoom(),pitch:window.__atlasMap.getPitch()})')
        page.get_by_role('button',name='Аналитика текущей территории').click()
        dialog=page.get_by_role('dialog',name='Тестовый Татарстан',exact=True);expect(dialog).to_be_visible(timeout=30000)
        expect(page.get_by_role('dialog',name='Найти на карте',exact=True)).to_have_count(0)
        expect(dialog.get_by_text('Индекс незакрытых',exact=True)).to_be_visible();page.screenshot(path=str(OUT/'territory-desktop.png'))
        dialog.get_by_label('Территория аналитики').select_option('district-a');expect(page.get_by_role('heading',name='Тестовый муниципальный район',exact=True)).to_be_visible()
        dialog=page.get_by_role('dialog');dialog.get_by_label('Территория аналитики').select_option('RU-TA')
        expect(page.get_by_role('heading',name='Тестовый Татарстан',exact=True)).to_be_visible()
        page.get_by_role('button',name='Для Сбера',exact=True).click();expect(dialog.get_by_text('Клиентский портфель',exact=True)).to_be_visible()
        page.screenshot(path=str(OUT/'sber-desktop.png'))
        check('Territory drill-down, historical complaints, Sber portfolio and competitor analytics load')
        page.get_by_role('button',name='Закрыть аналитику').click()
        restored=page.evaluate('({center:window.__atlasMap.getCenter().toArray(),zoom:window.__atlasMap.getZoom(),pitch:window.__atlasMap.getPitch()})')
        assert camera==restored,(camera,restored)
        check('Analytics never remounts or moves the map')
        page.get_by_role('navigation',name='Главная навигация').get_by_role('button',name='Аналитика',exact=True).click()
        page.get_by_role('button',name='Для Сбера',exact=True).click()
        page.get_by_role('button',name='Все клиенты и возможности').click()
        cards=page.locator('[data-client-id]');expect(cards).to_have_count(40,timeout=30000)
        page.get_by_role('navigation',name='Страницы клиентов').get_by_role('button',name='Далее',exact=True).click();expect(cards).to_have_count(40)
        expect(page.get_by_text('41–80 из 85',exact=True)).to_be_visible()
        page.get_by_role('navigation',name='Страницы клиентов').get_by_role('button',name='Далее',exact=True).click();expect(cards).to_have_count(5)
        check('All 85 clients accessible through 40/40/5 pagination')
        search=page.get_by_role('textbox',name='Поиск клиентов по ИНН, названию, ГОСБ или КМ');search.fill('1650000084');expect(cards).to_have_count(1)
        expect(cards.first.get_by_text('Нет адреса с подтверждёнными координатами. ИНН и ГОСБ не задают точку.',exact=True).first).to_be_visible()
        page.screenshot(path=str(OUT/'missing-address.png'))
        page.get_by_text('Разместить клиентов · адреса и проверка',exact=True).click()
        page.get_by_text('Поиск юридических адресов по ИНН',exact=True).click()
        expect(page.get_by_text('ATLAS_DADATA_TOKEN',exact=True)).to_be_visible()
        expect(page.get_by_role('button',name='Найти адреса клиентов текущего портфеля')).to_have_count(0)
        check('Missing addresses remain explicit; external lookup is off without a key and consent')
        page.get_by_role('button',name='Указать адрес / встречу',exact=True).click()
        editor=page.locator('.planning-editor');expect(editor).to_be_visible(timeout=30000)
        editor.get_by_label('Назначение адреса').select_option('office');editor.get_by_label('Адрес',exact=True).fill('Тестовый офис, 84')
        editor.get_by_label('Долгота',exact=True).fill('49.3');editor.get_by_label('Широта',exact=True).fill('55.8')
        editor.get_by_role('checkbox').check();editor.get_by_role('button',name='Подтвердить и сохранить адрес',exact=True).click()
        expect(editor.get_by_text('Адрес сохранён локально.',exact=True)).to_be_visible(timeout=15000)
        page.locator('dialog.modal[open]').get_by_role('button',name='Закрыть',exact=True).click()
        page.get_by_role('textbox',name='Поиск клиентов по ИНН, названию, ГОСБ или КМ').fill('1650000084')
        expect(page.locator('[data-client-id="fixture-84"]').get_by_role('button',name='На карте',exact=True)).to_be_visible(timeout=15000)
        check('A client from the last page gets a manual office and becomes mapped without reloading')
        search=page.get_by_role('textbox',name='Поиск клиентов по ИНН, названию, ГОСБ или КМ');search.fill('');expect(cards).to_have_count(40)
        page.evaluate('window.__atlasMap.jumpTo({center:[49.2,55.8],zoom:15,pitch:0})')
        page.wait_for_function('window.__atlasMap.queryRenderedFeatures({layers:["atlas-client-groups"]}).some(f=>f.properties.point_count>=80)',timeout=20000)
        expect(page.locator('.map-dom-bank-marker, .map-dom-signal-marker')).to_have_count(0)
        point=page.evaluate('window.__atlasMap.project([49.2,55.8])');page.mouse.click(point['x'],point['y']-12)
        group=page.get_by_role('region',name='Клиенты в группе');expect(group).to_be_visible(timeout=15000)
        expect(group.get_by_text('Клиенты в этой группе · 80',exact=True)).to_be_visible()
        group.get_by_role('button',name='Показать ещё',exact=True).click();expect(group.locator('.organization-row')).to_have_count(80)
        check('All 80 colocated clients can be opened, including cluster members beyond the first page')
        page.get_by_role('navigation',name='Главная навигация').get_by_role('button',name='Аналитика',exact=True).click()
        page.set_viewport_size({'width':390,'height':844});expect(page.get_by_role('dialog')).to_be_visible()
        page.screenshot(path=str(OUT/'analytics-mobile.png'))
        box=page.get_by_role('dialog').bounding_box();assert box and box['width']<=390 and box['height']<=844 and box['x']>=0 and box['y']>=0,box
        page.get_by_role('button',name='Закрыть аналитику').click();page.set_viewport_size({'width':1440,'height':1000})
        check('Analytics is responsive at 390×844 and restores desktop layout')
        report['mapErrors']+=page.evaluate('window.__errors')
        page.goto(BASE+'/?mode=public&diagnostics',wait_until='domcontentloaded');ready(page)
        page.get_by_role('button',name='Аналитика текущей территории').click();page.get_by_role('button',name='Для Сбера',exact=True).click()
        expect(page.get_by_text('Внутренние сделки, ФОТ и встречи доступны только локально в рабочем режиме.',exact=False)).to_be_visible(timeout=20000)
        assert 'Синтетический клиент' not in page.locator('body').inner_text()
        page.get_by_role('button',name='Закрыть аналитику').click()
        for i in range(2):
            page.get_by_role('button',name='Перейти в 3D',exact=True).click();expect(page.locator('button[data-map-mode]')).to_have_attribute('data-map-mode','3d')
            page.get_by_role('button',name='Перейти в 2D',exact=True).click();expect(page.locator('button[data-map-mode]')).to_have_attribute('data-map-mode','2d')
        check('Public mode has no private financial UI; 2D/3D remains deterministic')
        report['mapErrors']+=page.evaluate('window.__errors')
        assert report['pageErrors']==[],report['pageErrors']
        assert report['mapErrors']==[],report['mapErrors']
        assert report['externalRequests']==[],report['externalRequests']
        report['result']='passed'
    except Exception as error:
        report['result']='failed';report['error']=str(error);page.screenshot(path=str(OUT/'failure.png'));raise
    finally:
        (OUT/'browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));browser.close()
