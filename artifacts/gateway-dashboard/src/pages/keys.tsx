import { useState } from "react";
import {
  useListApiKeys,
  getListApiKeysQueryKey,
  useCreateApiKey,
  useDeleteApiKey,
  useUpdateApiKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Key, Plus, Trash2, Copy, Check, AlertTriangle } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

export default function Keys() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKeyData, setCreatedKeyData] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const { data, isLoading } = useListApiKeys({
    query: { queryKey: getListApiKeysQueryKey() },
  });

  const createMutation = useCreateApiKey();
  const deleteMutation = useDeleteApiKey();
  const updateMutation = useUpdateApiKey();

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName.trim()) return;
    createMutation.mutate(
      { data: { name: newKeyName } },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({ queryKey: getListApiKeysQueryKey() });
          setCreatedKeyData({ name: res.name, key: res.key });
          setNewKeyName("");
        },
        onError: (err: unknown) => {
          const msg = err instanceof Error ? err.message : "Failed to generate key";
          toast({ title: "Error", description: msg, variant: "destructive" });
        },
      }
    );
  };

  const handleCopy = () => {
    if (createdKeyData) {
      navigator.clipboard.writeText(createdKeyData.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Copied to clipboard" });
    }
  };

  const handleCloseCreate = () => {
    setCreateOpen(false);
    setCreatedKeyData(null);
    setNewKeyName("");
  };

  const handleToggleStatus = (id: string, currentStatus: boolean) => {
    updateMutation.mutate(
      { id, data: { isActive: !currentStatus } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListApiKeysQueryKey() });
        },
      }
    );
  };

  const handleDeleteConfirm = (id: string) => {
    deleteMutation.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListApiKeysQueryKey() });
          toast({ title: "Key deleted" });
          setDeleteConfirmId(null);
        },
      }
    );
  };

  const keys = data?.keys ?? [];

  return (
    <div className="flex-1 p-4 md:p-8 overflow-auto">
      {/* Header */}
      <div className="flex justify-between items-start md:items-center gap-3 mb-6 md:mb-8">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight mb-1">API Keys</h1>
          <p className="text-muted-foreground font-mono text-xs md:text-sm">
            Manage access tokens for the gateway proxy.
          </p>
        </div>
        <Button
          onClick={() => setCreateOpen(true)}
          className="font-mono uppercase tracking-wider text-xs md:text-sm shrink-0"
          data-testid="button-generate-key"
        >
          <Plus className="w-4 h-4 mr-1.5" />
          <span className="hidden sm:inline">Generate_Key</span>
          <span className="sm:hidden">New</span>
        </Button>
      </div>

      {/* Keys list */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 bg-muted animate-pulse rounded-md" />
          ))}
        </div>
      ) : keys.length === 0 ? (
        <Card className="border-border">
          <CardContent className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
            <Key className="w-10 h-10 opacity-20" />
            <p className="font-mono text-sm opacity-50">No keys provisioned. Generate one to start.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {keys.map((key) => (
            <Card
              key={key.id}
              className="border-border"
              data-testid={`card-key-${key.id}`}
            >
              <CardContent className="p-4">
                {/* Mobile layout: stacked */}
                <div className="flex flex-col gap-3">
                  {/* Top row: name + badge + actions */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Key className="w-4 h-4 text-primary shrink-0" />
                      <span className="font-medium truncate">{key.name}</span>
                      <Badge
                        variant={key.isActive ? "default" : "secondary"}
                        className="font-mono rounded-sm text-xs shrink-0"
                      >
                        {key.isActive ? "ACTIVE" : "OFF"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Switch
                        checked={key.isActive}
                        onCheckedChange={() => handleToggleStatus(key.id, key.isActive)}
                        disabled={updateMutation.isPending}
                        data-testid={`switch-key-${key.id}`}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => setDeleteConfirmId(key.id)}
                        disabled={deleteMutation.isPending}
                        data-testid={`button-delete-${key.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>

                  {/* Bottom row: key preview + metadata */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground font-mono">
                    <span className="text-primary/70">{key.keyPreview}</span>
                    <span>Created {format(new Date(key.createdAt), "MMM d, yyyy")}</span>
                    <span>Last used: {key.lastUsed ? format(new Date(key.lastUsed), "MMM d, HH:mm") : "Never"}</span>
                    <span>{key.requestCount.toLocaleString()} requests</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Key Dialog */}
      <Dialog open={createOpen} onOpenChange={handleCloseCreate}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md border-border bg-card">
          {!createdKeyData ? (
            <form onSubmit={handleCreate}>
              <DialogHeader>
                <DialogTitle className="font-mono uppercase tracking-wider text-primary">
                  Generate API Key
                </DialogTitle>
                <DialogDescription className="text-muted-foreground text-sm">
                  Create a new token to authenticate gateway requests.
                </DialogDescription>
              </DialogHeader>
              <div className="py-5">
                <Label htmlFor="name" className="font-mono text-xs uppercase text-muted-foreground">
                  Key Name
                </Label>
                <Input
                  id="name"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="e.g. Production App"
                  className="mt-2 bg-background"
                  autoFocus
                  data-testid="input-key-name"
                />
              </div>
              <DialogFooter className="gap-2">
                <Button type="button" variant="outline" onClick={handleCloseCreate}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={createMutation.isPending || !newKeyName.trim()}
                  data-testid="button-confirm-generate"
                >
                  {createMutation.isPending ? "Generating..." : "Generate"}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="font-mono uppercase tracking-wider text-primary">
                  Key Generated
                </DialogTitle>
                <DialogDescription className="text-destructive font-semibold mt-1">
                  Copy this key now — it will not be shown again.
                </DialogDescription>
              </DialogHeader>
              <div className="py-4">
                <div className="bg-background border border-primary/30 p-3 rounded-md flex items-start justify-between gap-3">
                  <code className="text-primary font-mono text-xs break-all leading-relaxed flex-1">
                    {createdKeyData.key}
                  </code>
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={handleCopy}
                    className="shrink-0 h-8 w-8"
                    data-testid="button-copy-key"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                  </Button>
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={handleCloseCreate}
                  className="w-full"
                  data-testid="button-done"
                >
                  I have copied the key
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <Dialog open={!!deleteConfirmId} onOpenChange={() => setDeleteConfirmId(null)}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-sm border-border bg-card">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive font-mono uppercase">
              <AlertTriangle className="w-4 h-4" />
              Delete Key
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-sm">
              This API key will be permanently revoked. Any applications using it will stop working.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 mt-4">
            <Button variant="outline" onClick={() => setDeleteConfirmId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirmId && handleDeleteConfirm(deleteConfirmId)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
