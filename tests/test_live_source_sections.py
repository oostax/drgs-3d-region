import copy,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/live'))
from source_section_geocoding import clip_between_intersections,source_section,length,lines
from geocoding import match_address_candidates

def line(points):return {'type':'LineString','coordinates':points}
def vertical(x):return line([[x,54.99],[x,55.01]])

class SourceSectionTests(unittest.TestCase):
    def test_clip_uses_actual_crossings_and_arc_midpoint_without_mutating_full_street(self):
        main=line([[49,55],[49.004,55],[49.01,55]]);before=copy.deepcopy(main)
        result=clip_between_intersections(main,vertical(49.002),vertical(49.006))
        self.assertEqual(result['status'],'matched');self.assertEqual(result['bbox'],[49.002,55,49.006,55])
        self.assertAlmostEqual(result['representativeCoordinate'][0],49.004,places=6)
        self.assertEqual(result['representativeCoordinate'][1],55);self.assertEqual(main,before)
        self.assertLess(sum(length(p) for p in lines(result['geometry'])),300)

    def test_multiple_distant_crossings_do_not_choose_arbitrary_boundary(self):
        start={'type':'MultiLineString','coordinates':[vertical(49.002)['coordinates'],vertical(49.004)['coordinates']]}
        result=clip_between_intersections(line([[49,55],[49.01,55]]),start,vertical(49.008))
        self.assertEqual((result['status'],result['reason']),('ambiguous','boundary-crosses-street-in-several-places'))
        self.assertNotIn('representativeCoordinate',result)

    def test_disconnected_ends_and_distinct_alternative_corridors_are_not_confirmed(self):
        main={'type':'MultiLineString','coordinates':[[[49,55],[49.004,55]],[[49.006,55],[49.01,55]]]}
        self.assertEqual(clip_between_intersections(main,vertical(49.002),vertical(49.008))['status'],'unmatched')
        alternatives={'type':'MultiLineString','coordinates':[[[49.002,55],[49.004,55.003],[49.006,55]],[[49.002,55],[49.004,54.997],[49.006,55]]]}
        result=clip_between_intersections(alternatives,vertical(49.002),vertical(49.006))
        self.assertEqual((result['status'],result['reason']),('ambiguous','section-has-distinct-alternative-corridors'))

    def test_source_clause_belongs_to_its_primary_street_not_a_cross_street(self):
        street={'geometry':line([[49,55],[49.01,55]])}
        text='Движение ограничат по улице Пушкина на участке от улицы Карла Маркса до улицы Большой Красной.'
        resolve=lambda name:{'status':'matched','streetId':name,'sourceUrls':[], 'geometry':vertical(49.002 if 'Карла' in name else 49.006)}
        result=source_section(street,'улице Пушкина',text,resolve)
        self.assertEqual(result['status'],'matched');self.assertIn(result['sourceQuote'],text)
        self.assertEqual(result['from']['name'],'улицы Карла Маркса')
        self.assertEqual(result['to']['name'],'улицы Большой Красной')
        self.assertIsNone(source_section(street,'улицы Карла Маркса',text,resolve))
        self.assertEqual(source_section(street,'улице Пушкина',text,lambda name:{'status':'ambiguous'})['reason'],'boundary-street-not-unique')

    def test_all_adjectives_in_an_inflected_boundary_name_are_matched(self):
        index={'schemaVersion':1,'territoryId':'city','sourceUrl':'https://www.openstreetmap.org','streets':[{'id':'red','name':'Большая Красная улица','territoryId':'city','coordinates':[49,55],'bbox':[49,55,49.1,55.1],'geometry':line([[49,55],[49.1,55.1]])}]}
        result=match_address_candidates(['улицы Большой Красной'],'city',index)
        self.assertEqual((result['status'],result['streetId']),('matched','red'))

if __name__=='__main__':unittest.main()
