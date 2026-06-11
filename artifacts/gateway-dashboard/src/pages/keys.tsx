import { useState } from "react";
import { 
  useListApiKeys, getListApiKeysQueryKey, 
  useCreateApiKey, useDeleteApiKey, useUpdateApiKey 
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Key, Plus, Trash2, Copy, Check } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

export default function Keys() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKeyData, setCreatedKeyData] = useState<{name: string, key: string} | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, isLoading } = useListApiKeys({
    query: { queryKey: getListApiKeysQueryKey() }
  });

  const createMutation = useCreateApiKey();
  const deleteMutation = useDeleteApiKey();
  const updateMutation = useUpdateApiKey();

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName.trim()) return;

    createMutation.mutate({ data: { name: newKeyName } }, {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getListApiKeysQueryKey() });
        setCreatedKeyData({ name: res.name, key: res.key });
        setNewKeyName("");
      }
    });
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
    updateMutation.mutate({ id, data: { isActive: !currentStatus } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListApiKeysQueryKey() });
        toast({ title: "Key status updated" });
      }
    });
  };

  const handleDelete = (id: string) => {
    if (confirm("Are you sure you want to permanently delete this API key? This action cannot be undone.")) {
      deleteMutation.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListApiKeysQueryKey() });
          toast({ title: "Key deleted" });
        }
      });
    }
  };

  return (
    <div className="flex-1 p-8 overflow-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">API Keys</h1>
          <p className="text-muted-foreground font-mono text-sm">Manage access tokens for the Gateway proxy.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="font-mono uppercase tracking-wider">
          <Plus className="w-4 h-4 mr-2" /> Generate_Key
        </Button>
      </div>

      <Card className="border-border shadow-md">
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/30">
              <TableRow className="border-border">
                <TableHead className="font-mono font-bold text-foreground">Name</TableHead>
                <TableHead className="font-mono font-bold text-foreground">Token Preview</TableHead>
                <TableHead className="font-mono font-bold text-foreground">Created</TableHead>
                <TableHead className="font-mono font-bold text-foreground">Last Used</TableHead>
                <TableHead className="font-mono font-bold text-foreground">Usage</TableHead>
                <TableHead className="font-mono font-bold text-foreground">Status</TableHead>
                <TableHead className="font-mono font-bold text-foreground text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground font-mono">
                    FETCHING_KEYS...
                  </TableCell>
                </TableRow>
              ) : data?.keys?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground font-mono opacity-50">
                    No keys provisioned. Generate one to start.
                  </TableCell>
                </TableRow>
              ) : (
                data?.keys?.map((key) => (
                  <TableRow key={key.id} className="border-border">
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell className="font-mono text-muted-foreground">{key.keyPreview}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{format(new Date(key.createdAt), "MMM d, yyyy")}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {key.lastUsed ? format(new Date(key.lastUsed), "MMM d, HH:mm") : 'Never'}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{key.requestCount.toLocaleString()}</TableCell>
                    <TableCell>
                      <Badge variant={key.isActive ? "default" : "secondary"} className="font-mono rounded-sm">
                        {key.isActive ? "ACTIVE" : "INACTIVE"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-3">
                        <Switch 
                          checked={key.isActive} 
                          onCheckedChange={() => handleToggleStatus(key.id, key.isActive)}
                          disabled={updateMutation.isPending}
                        />
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => handleDelete(key.id)}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={handleCloseCreate}>
        <DialogContent className="sm:max-w-md border-border bg-card">
          {!createdKeyData ? (
            <form onSubmit={handleCreate}>
              <DialogHeader>
                <DialogTitle className="font-mono uppercase tracking-wider text-primary">Generate API Key</DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  Create a new token to authenticate requests to the gateway proxy.
                </DialogDescription>
              </DialogHeader>
              <div className="py-6">
                <Label htmlFor="name" className="font-mono text-xs uppercase text-muted-foreground">Key Name</Label>
                <Input 
                  id="name" 
                  value={newKeyName} 
                  onChange={(e) => setNewKeyName(e.target.value)} 
                  placeholder="e.g. Production App" 
                  className="mt-2 font-sans bg-background"
                  autoFocus
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={handleCloseCreate}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending || !newKeyName.trim()}>
                  {createMutation.isPending ? "Generating..." : "Generate"}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="font-mono uppercase tracking-wider text-primary">Key Generated</DialogTitle>
                <DialogDescription className="text-destructive font-bold mt-2">
                  Please copy this key now. You will not be able to see it again!
                </DialogDescription>
              </DialogHeader>
              <div className="py-6 space-y-4">
                <div className="bg-background border border-border p-4 rounded-md flex items-center justify-between gap-4">
                  <code className="text-primary font-mono break-all">{createdKeyData.key}</code>
                  <Button size="icon" variant="outline" onClick={handleCopy} className="shrink-0">
                    {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleCloseCreate} className="w-full">I have copied the key</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
