"""Real pointer/touch/keyboard regression. Synthetic local data; no external APIs."""
import json
import math
import os
import re
import struct
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('ATLAS_BROWSER_URL', 'http://127.0.0.1:3200')
OUT = Path(os.environ.get('ATLAS_BROWSER_OUTPUT', '/tmp/atlas-compass-browser')) / 'compass'
OUT.mkdir(parents=True, exist_ok=True)
report = {'fixture': 'actual Atlas, synthetic local sources, real Chromium WebGL', 'checks': [], 'pageErrors': [], 'mapErrors': []}
metadata = json.dumps({'vector_layers': [{'id': 'building', 'fields': {}}, {'id': 'building_part', 'fields': {}}]}).encode()
archive = bytearray(128 + len(metadata)); archive[:7] = b'PMTiles'; archive[7] = 3
for offset, value in [(8,127),(16,1),(24,128),(32,len(metadata)),(40,len(archive)),(56,len(archive))]: struct.pack_into('<Q',archive,offset,value)
for offset,value in [(96,1),(97,1),(98,1),(99,1),(100,10),(101,15),(118,13)]: archive[offset]=value
for offset,value in [(102,-1800000000),(106,-850000000),(110,1800000000),(114,850000000)]: struct.pack_into('<i',archive,offset,value)
archive[128:] = metadata

def install(page):
    page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
    page.route('**/*', lambda route: route.continue_() if urlsplit(route.request.url).hostname in ('127.0.0.1','localhost') else route.abort())
    page.route('**/api/map/style', lambda route: route.fulfill(json={'version':8,'glyphs':BASE+'/__fixture/fonts/{fontstack}/{range}.pbf','sources':{},'layers':[{'id':'background','type':'background','paint':{'background-color':'#d9e2d4'}}]}))
    page.route('**/__fixture/fonts/**', lambda route: route.fulfill(body=b'',content_type='application/x-protobuf'))
    def tiles(route):
        match = re.search(r'bytes=(\d+)-(\d*)', route.request.headers.get('range', ''))
        start = int(match[1]) if match else 0
        end = min(len(archive)-1, int(match[2]) if match and match[2] else len(archive)-1)
        headers = {'content-type':'application/octet-stream','accept-ranges':'bytes'}
        if match: headers['content-range'] = f'bytes {start}-{end}/{len(archive)}'
        route.fulfill(status=206 if match else 200, headers=headers, body=bytes(archive[start:end+1]))
    page.route('**/api/tiles/buildings*', tiles)

def load(page):
    install(page)
    page.goto(BASE+'/?mode=work&diagnostics', wait_until='domcontentloaded')
    page.wait_for_function('window.__atlasMap && document.querySelector("[data-atlas-ready=true]")', timeout=45000)
    page.evaluate('window.__compassMap=window.__atlasMap; window.__compassErrors=[]; window.__atlasMap.on("error",e=>window.__compassErrors.push(String(e.error)))')

def check(text):
    report['checks'].append(text); print(text, flush=True)

def state(page):
    return page.evaluate('({center:window.__atlasMap.getCenter().toArray(),zoom:window.__atlasMap.getZoom(),bearing:window.__atlasMap.getBearing(),pitch:window.__atlasMap.getPitch(),maxPitch:window.__atlasMap.getMaxPitch(),padding:window.__atlasMap.getPadding(),sameMap:window.__compassMap===window.__atlasMap})')

def stable_camera(before, after):
    assert before['center'] == after['center'], (before, after)
    assert before['zoom'] == after['zoom'], (before, after)
    assert before['padding'] == after['padding'], (before, after)
    assert after['sameMap']

def settle(page):
    page.wait_for_function('!window.__atlasMap.isMoving()'); page.wait_for_timeout(120)

def open_compass(page):
    page.get_by_role('button',name='3D-компас',exact=True).click()
    dialog=page.get_by_role('dialog',name='3D-компас',exact=True); expect(dialog).to_be_visible()
    return dialog

def centre(locator):
    box=locator.bounding_box(); assert box
    return box['x']+box['width']/2, box['y']+box['height']/2

def orbit(page, degrees=90):
    x,y=centre(page.locator('[data-compass-ring]')); r=86
    page.mouse.move(x,y-r); page.mouse.down()
    for step in range(1,31):
        angle=math.radians(degrees*step/30)
        page.mouse.move(x+r*math.sin(angle),y-r*math.cos(angle))
    page.mouse.up(); settle(page)

def drag_centre(page, dx, dy):
    x,y=centre(page.locator('[data-compass-tilt]'))
    page.mouse.move(x,y); page.mouse.down(); page.mouse.move(x+dx,y+dy,steps=18); page.mouse.up(); settle(page)

with sync_playwright() as p:
    executable=os.environ.get('CHROMIUM_PATH')
    browser=p.chromium.launch(headless=True,**({'executable_path':executable} if executable else {}),args=['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    context=browser.new_context(viewport={'width':1440,'height':960},reduced_motion='reduce')
    page=context.new_page()
    try:
        load(page)
        page.evaluate('window.__atlasMap.jumpTo({center:[49.2,55.8],zoom:15,bearing:25,pitch:0})');settle(page)
        initial=state(page);open_compass(page);stable_camera(initial,state(page))
        expect(page.locator('[data-compass-tilt]')).to_have_attribute('aria-disabled','true')
        orbit(page); flat=state(page);stable_camera(initial,flat);assert abs(flat['bearing']+65)<0.5 and flat['pitch']==0,flat
        drag_centre(page,35,-40);assert state(page)['pitch']==0
        page.keyboard.press('Escape');expect(page.get_by_role('dialog',name='3D-компас',exact=True)).to_have_count(0)
        expect(page.get_by_role('button',name='3D-компас',exact=True)).to_be_focused()
        check('Opening preserves camera; 2D rotates but stays flat; Escape returns focus')
        page.get_by_role('button',name='Перейти в 3D',exact=True).click();settle(page)
        page.evaluate('window.__atlasMap.jumpTo({bearing:0,pitch:25})');settle(page)
        initial=state(page);open_compass(page)
        drag_centre(page,40,-60);after=state(page);stable_camera(initial,after)
        assert abs(after['bearing']+24)<0.5 and abs(after['pitch']-55)<0.5,after
        page.screenshot(path=str(OUT/'compass-desktop.png'))
        orbit(page,220);after=state(page);stable_camera(initial,after)
        assert abs(after['bearing']-116)<0.5 and abs(after['pitch']-55)<0.5,after
        check('Centre changes both angles; outer ring is continuous across ±180 degrees')
        x,y=centre(page.locator('[data-compass-tilt]'));page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+360,20,steps=15)
        assert page.locator('[data-compass-tilt]').evaluate('(e)=>e.hasPointerCapture(1)')
        page.mouse.up();settle(page);stable_camera(initial,state(page));assert state(page)['pitch']==75
        frozen=state(page);page.mouse.move(900,700,steps=8);settle(page);assert state(page)==frozen
        check('Pointer capture works outside compass, pitch clamps at 75°, release stops drag')
        ring=page.locator('[data-compass-ring]');ring.press('Home');settle(page);assert state(page)['bearing']==0
        ring.press('Shift+ArrowRight');settle(page);assert state(page)['bearing']==15
        tilt=page.locator('[data-compass-tilt]');tilt.press('Home');settle(page);assert state(page)['pitch']==0
        tilt.press('ArrowUp');settle(page);assert state(page)['pitch']==5
        x,y=centre(ring);page.mouse.dblclick(x,y-86);settle(page);assert state(page)['bearing']==0
        x,y=centre(tilt);page.mouse.dblclick(x,y);settle(page);assert state(page)['pitch']==0
        expect(page.locator('button[data-map-mode]')).to_have_attribute('data-map-mode','3d')
        check('Keyboard and double-click reset work without changing the selected 3D mode')
        # Cancel and tab hiding must never leave a captured pointer or queued write.
        page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+20,y-30,steps=3);page.wait_for_timeout(100)
        page.locator('[data-compass-tilt]').dispatch_event('pointercancel',{'pointerId':1})
        canceled=state(page);page.mouse.move(x+100,y-100,steps=4);page.mouse.up();settle(page);assert state(page)==canceled
        check('Pointer cancellation cannot leave a running drag')
        page.get_by_role('button',name='Закрыть компас',exact=True).click()
        page.get_by_role('navigation',name='Главная навигация').get_by_role('button',name='Карта',exact=True).click()
        page.get_by_role('button',name='Банки',exact=True).click();expect(page.locator('.context-panel')).to_be_visible();settle(page)
        panel_camera=state(page);open_compass(page);expect(page.locator('.context-panel')).to_be_visible();stable_camera(panel_camera,state(page))
        page.keyboard.press('Escape');expect(page.locator('.context-panel')).to_be_visible();stable_camera(panel_camera,state(page))
        check('Compass and Escape preserve the current object/list panel and its camera padding')
        open_compass(page);page.set_viewport_size({'width':390,'height':844});settle(page)
        dialog=page.get_by_role('dialog',name='3D-компас',exact=True);expect(dialog).to_be_visible()
        box=dialog.bounding_box();assert box and box['x']>=0 and box['y']>=0 and box['x']+box['width']<=390 and box['y']+box['height']<=844,box
        expect(page.get_by_role('button',name='Перейти в 2D',exact=True)).to_be_visible()
        page.locator('[data-compass-tilt]').press('End');settle(page)
        mobile_pose=state(page);report['mobilePose']=mobile_pose
        assert mobile_pose['maxPitch']==60 and abs(mobile_pose['pitch']-60)<1e-6,mobile_pose
        page.screenshot(path=str(OUT/'compass-mobile.png'))
        page.set_viewport_size({'width':1440,'height':960});settle(page)
        page.locator('[data-compass-tilt]').press('End');settle(page)
        desktop_pose=state(page);report['desktopPose']=desktop_pose
        assert desktop_pose['maxPitch']==75 and abs(desktop_pose['pitch']-75)<1e-6,desktop_pose
        page.get_by_role('button',name='Перейти в 2D',exact=True).click();settle(page);assert state(page)['pitch']==0
        expect(page.get_by_role('dialog',name='3D-компас',exact=True)).to_have_count(0)
        check('390px layout remains usable, resize restores 60°/75° limits, 2D remains deterministic')
        report['mapErrors']+=page.evaluate('window.__compassErrors')
        touch_context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,reduced_motion='reduce')
        touch=touch_context.new_page();load(touch)
        touch.get_by_role('button',name='Перейти в 3D',exact=True).tap();settle(touch)
        touch.evaluate('window.__atlasMap.jumpTo({center:[49.2,55.8],zoom:15,bearing:0,pitch:20})');settle(touch)
        touch.get_by_role('button',name='3D-компас',exact=True).tap()
        expect(touch.get_by_role('dialog',name='3D-компас',exact=True)).to_be_visible()
        x,y=centre(touch.locator('[data-compass-tilt]'));before=state(touch)
        cdp=touch_context.new_cdp_session(touch)
        cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y,'id':0}]})
        for i in range(1,11): cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x+2*i,'y':y-4*i,'id':0}]})
        cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]});settle(touch)
        after=state(touch);stable_camera(before,after);assert abs(after['pitch']-40)<1 and abs(after['bearing']+12)<1,after
        touch.screenshot(path=str(OUT/'compass-touch.png'))
        check('Real touch pointer drag changes pitch/bearing without scrolling or panning the map')
        report['mapErrors']+=touch.evaluate('window.__compassErrors')
        assert report['pageErrors']==[],report['pageErrors'];assert report['mapErrors']==[],report['mapErrors']
        report['result']='passed'
    except Exception as error:
        report['result']='failed';report['error']=str(error);page.screenshot(path=str(OUT/'failure.png'));raise
    finally:
        (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));browser.close()
