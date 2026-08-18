import { PageHeader } from "@/components/ui/PageHeader";
import { FinishWork } from "@/components/workspace/FinishWork";

/**
 * `?projectId=` / `?day=` preselect the close-out — the Done view links straight
 * here from the day whose standup is missing, and landing on today's default
 * would quietly close out the wrong day.
 */
export default async function DayPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string; day?: string }>;
}) {
  const { projectId, day } = await searchParams;
  return (
    <div className="min-h-screen">
      <PageHeader
        title="Finish work"
        subtitle="Close out a working day: what finished, what never made the board, and the standup that comes out of it."
      />
      <div className="px-8 py-6">
        <div className="mx-auto max-w-3xl">
          <FinishWork initialProjectId={projectId} initialDay={day} />
        </div>
      </div>
    </div>
  );
}
