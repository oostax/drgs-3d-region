"""Shared source-role and precision checks for every geocoding route."""
import re

VERSION='location-quality-v1'
CONTACT=re.compile(r'(?:подробност[ьи]\s+по\s+телефон\w*|справки\s+по\s+телефон\w*|адрес\s+редакции|юридический\s+адрес|для\s+(?:оплаты|заключения\s+соглашения|обращени[яй])[^\n]{0,80}(?:адрес|улиц)|обращаться\s+по\s+адресу)[^\n]*',re.I)


def location_text(text):
    # Preserve positions and newlines so accepted quotes remain source substrings.
    return CONTACT.sub(lambda m:' '*len(m.group()),text)


def constrain_precision(result, text):
    if result.get('status')!='matched':return result
    result={**result,'qualityVersion':VERSION}
    if result.get('precision')=='building' and re.search(r'\b(?:во?\s+(?:обновленном\s+)?дворе|праздник\w*\s+двор\w*|дворов\w*\s+территор\w*|на\s+территории)\b',text,re.I):
        result.update(precision='site',geometry=None,bbox=None,eventGeometryConfirmed=False,
            note='Подтверждён адрес здания как ориентир. Точная геометрия двора или площадки внутри территории не установлена.')
    else:
        result['eventGeometryConfirmed']=bool(result.get('sourceSection'))
    return result
