import { useState, type ReactElement, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function DeleteConnectionButton({
  connectionId,
  connectionName,
  onDeleted,
  render,
  children,
}: {
  connectionId: string;
  connectionName: string;
  onDeleted?: () => void;
  render?: ReactElement;
  children?: ReactNode;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    setDeleting(true);
    const res = await fetch(`/api/connections/${connectionId}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setOpen(false);
      if (onDeleted) onDeleted();
      else navigate(0);
    } else {
      setDeleting(false);
    }
  }

  const triggerRender = render ?? (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground hover:text-destructive"
      onClick={(e: React.MouseEvent) => e.preventDefault()}
    />
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={triggerRender}>
        {children ?? <Trash2 className="h-4 w-4" />}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete &ldquo;{connectionName}&rdquo;?</DialogTitle>
          <DialogDescription>
            This will remove the connection, its sandbox container, schema cache,
            and all related data. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
