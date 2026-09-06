"""Local-only MTProto login. Secrets/session never cross the loopback interface."""
import asyncio,base64,io,os,secrets,threading,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import parse_qs
import runtime_paths
from telegram_connector import _client
import qrcode
from qrcode.image.svg import SvgPathImage
from telethon.errors import SessionPasswordNeededError

TOKEN=secrets.token_urlsafe(24)
state={'image':'','message':'Готовим QR-код…','password':None,'need_password':False,'done':False}
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        if self.headers.get('Host') not in ('127.0.0.1:3211','localhost:3211'):
            self.send_error(403);return
        message=state['message'];image='<img alt="QR-код входа в Telegram" width="280" height="280" src="data:image/svg+xml;base64,'+state['image']+'">' if state['image'] and not state['need_password'] and not state['done'] else ''
        form='<form method="post"><input type="hidden" name="token" value="'+TOKEN+'"><label>Пароль двухэтапной проверки <input name="password" type="password" autocomplete="current-password" required autofocus></label><button>Войти</button></form>' if state['need_password'] else ''
        html='<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+('' if state['need_password'] or state['done'] else '<meta http-equiv="refresh" content="5">')+'<title>Telegram · Сбер Атлас</title><style>body{font:17px system-ui;background:#eef2ec;color:#20392d;max-width:540px;margin:8vh auto;padding:24px}h1{font-size:32px}img{display:block;margin:24px auto}input,button{font:inherit;padding:12px;margin-top:16px;display:block}button{background:#17653e;color:white;border:0;border-radius:8px}</style><h1>Подключение Telegram</h1><p>'+message+'</p>'+image+form+'<p>На телефоне: Telegram → Настройки → Устройства → Подключить устройство. Сканируйте код отдельным аккаунтом для Атласа.</p><small>Сессия сохраняется только на этом Mac. После входа страница закроет доступ автоматически.</small></html>'
        self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Referrer-Policy','no-referrer');self.send_header('X-Frame-Options','DENY');self.end_headers();self.wfile.write(html.encode())
    def do_POST(self):
        if self.headers.get('Origin') not in ('http://127.0.0.1:3211','http://localhost:3211') or int(self.headers.get('Content-Length','0'))>4096:
            self.send_error(403);return
        values=parse_qs(self.rfile.read(int(self.headers.get('Content-Length','0'))).decode())
        if not secrets.compare_digest(values.get('token',[''])[0],TOKEN):self.send_error(403);return
        state['password']=values.get('password',[''])[0]
        self.send_response(303);self.send_header('Location','/');self.end_headers()

async def main():
    os.umask(0o077)
    server=ThreadingHTTPServer(('127.0.0.1',3211),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    client=_client()
    try:
        await client.connect()
        if not await client.is_user_authorized():
            state['message']='Отсканируйте QR-код в Telegram на телефоне.'
            deadline=time.monotonic()+1800
            while time.monotonic()<deadline:
                qr=await client.qr_login();out=io.BytesIO();qrcode.make(qr.url,image_factory=SvgPathImage).save(out);state['image']=base64.b64encode(out.getvalue()).decode()
                try:
                    await qr.wait(timeout=55);break
                except asyncio.TimeoutError:continue
                except SessionPasswordNeededError:
                    state['need_password']=True;state['message']='Введите пароль двухэтапной проверки на этой локальной странице.'
                    while time.monotonic()<deadline:
                        if state['password'] is None:await asyncio.sleep(1);continue
                        password=state['password'];state['password']=None
                        try:await client.sign_in(password=password);break
                        except Exception:state['message']='Пароль не подошёл. Попробуйте ещё раз.'
                        finally:password=None
                    break
        state['done']=await client.is_user_authorized();state['need_password']=False;state['image']=''
        state['message']='Telegram подключён. Можно вернуться к карте.' if state['done'] else 'Время входа истекло. Запустите настройку повторно.'
        print('Telegram login:', 'authorized' if state['done'] else 'expired',flush=True)
        await asyncio.sleep(30)
    finally:await client.disconnect();server.shutdown()
if __name__=='__main__':asyncio.run(main())
