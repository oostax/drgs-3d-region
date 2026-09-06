import Atlas from "@/components/Atlas";
import { modeOf } from "@/lib/types";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  return <Atlas initialMode={modeOf((await searchParams).mode)} />;
}
