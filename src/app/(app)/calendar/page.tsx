import { PageHeader } from "@/components/ui/PageHeader";
import { CalendarView } from "@/components/workspace/CalendarView";

export default function CalendarPage() {
  return (
    <div className="flex h-screen min-h-0 flex-col">
      <PageHeader
        title="Calendar"
        subtitle="Your tasks and Google Calendar events, week by week. Synced live with Google."
      />
      <CalendarView />
    </div>
  );
}
