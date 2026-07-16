import { PageHeader } from "@/components/ui/PageHeader";
import { DailyFocus } from "@/components/workspace/DailyFocus";

export default function TodayPage() {
  return (
    <div className="min-h-screen">
      <PageHeader
        title="Today"
        subtitle="Your shortlist for the day — planned and in-progress tasks, nothing else."
      />
      <div className="px-8 py-6">
        <div className="mx-auto max-w-3xl">
          <DailyFocus />
        </div>
      </div>
    </div>
  );
}
