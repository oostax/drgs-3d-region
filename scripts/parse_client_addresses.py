"""Read a small local CSV/XLSX from stdin; never access the network."""
import csv,io,json,sys,zipfile,xml.etree.ElementTree as ET
from import_xlsx import open_workbook,NS
MAX_BYTES=5*1024*1024;MAX_ROWS=5000

def parse(payload,kind):
    if len(payload)>MAX_BYTES:raise ValueError('Файл должен быть не больше 5 МБ.')
    if kind=='csv':
        try:text=payload.decode('utf-8-sig')
        except UnicodeDecodeError:text=payload.decode('cp1251')
        first=text.splitlines()[0] if text.splitlines() else ''
        delimiter=max([';','\t',','],key=first.count)
        rows=list(csv.reader(io.StringIO(text),delimiter=delimiter))
    else:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            if len(archive.infolist())>2000 or sum(i.file_size for i in archive.infolist())>30*1024*1024:raise ValueError('Книга слишком велика после распаковки.')
            if any(i.flag_bits&1 for i in archive.infolist()):raise ValueError('Защищённую паролем книгу нужно сохранить без пароля.')
        with open_workbook(io.BytesIO(payload)) as book:
            sheets=[s for s in book.sheets if s['state']=='visible']
            if not sheets:raise ValueError('В книге нет видимого листа.')
            sheet=sheets[0]
            # No cached formula result is treated as an independently supplied
            # client address or INN. Formulas are never evaluated here.
            with book.archive.open(sheet['path']) as handle:
                for _,e in ET.iterparse(handle,events=('end',)):
                    if e.tag==NS+'f':raise ValueError('Сохраните первый лист как значения: формулы не принимаются.')
                    e.clear()
            rows=[]
            for number,cells in book.rows(sheet):
                if number>MAX_ROWS+1:raise ValueError('Можно импортировать не больше 5000 строк.')
                max_col=0;indexed={}
                for col,value in cells.items():
                    index=0
                    for letter in col:index=index*26+ord(letter)-64
                    if index>32:raise ValueError('В шаблоне допускается не больше 32 столбцов.')
                    indexed[index-1]=value or '';max_col=max(max_col,index)
                rows.append([indexed.get(i,'') for i in range(max_col)])
    rows=[r for r in rows if any(str(v).strip() for v in r)]
    if not rows:raise ValueError('Файл пуст.')
    if len(rows)>MAX_ROWS+1:raise ValueError('Можно импортировать не больше 5000 строк.')
    if any(len(r)>32 or any(len(str(v))>1500 for v in r) for r in rows):raise ValueError('Слишком длинное значение или слишком много столбцов.')
    return {'headers':rows[0],'rows':rows[1:]}

if __name__=='__main__':
    try:
        result=parse(sys.stdin.buffer.read(MAX_BYTES+1),sys.argv[1]);print(json.dumps(result,ensure_ascii=False))
    except (ValueError,KeyError,csv.Error,zipfile.BadZipFile,ET.ParseError,UnicodeError) as e:
        print(json.dumps({'error':str(e)},ensure_ascii=False));sys.exit(1)
