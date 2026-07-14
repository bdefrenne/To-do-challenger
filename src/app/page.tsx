import { PageHeader } from "@/components/ui/PageHeader";
import { TaskTable } from "@/components/workspace/TaskTable";

export default function ListPage() {
  return (
    <div className="min-h-screen">
      <PageHeader
        title="All tasks"
        subtitle="Everything on your plate, grouped by status. Drag to reorder or nest; drop into a group to change status."
      />
      <div className="px-8 py-6">
        <TaskTable />
      </div>
    </div>
  );
}
