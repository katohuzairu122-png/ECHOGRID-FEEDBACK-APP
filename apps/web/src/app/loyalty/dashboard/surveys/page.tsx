import { getSurveysHub } from '@/lib/surveys';
import { SurveysView } from './surveys-view';

interface SurveysPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Customer Surveys (H2). Session protection comes from the customer dashboard layout and customerApiFetch. */
export default async function SurveysPage({ searchParams }: SurveysPageProps) {
  const raw = (await searchParams).offset;
  const parsed = Number(Array.isArray(raw) ? raw[0] : raw);
  const offset = Number.isInteger(parsed) && parsed > 0 && parsed <= 100_000 ? parsed : 0;
  return <SurveysView data={await getSurveysHub(offset)} />;
}
