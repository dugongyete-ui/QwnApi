import { useState } from "react";
import { useGetChatHistory, getGetChatHistoryQueryKey, useGetConversation, getGetConversationQueryKey, useDeleteConversation } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { MessageSquare, Trash2, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export default function History() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: history, isLoading: historyLoading } = useGetChatHistory({
    limit: 50,
    offset: 0
  }, {
    query: { queryKey: getGetChatHistoryQueryKey() }
  });

  const { data: conversation, isLoading: convLoading } = useGetConversation(
    selectedId || "",
    { query: { enabled: !!selectedId, queryKey: getGetConversationQueryKey(selectedId || "") } }
  );

  const deleteMutation = useDeleteConversation();

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (confirm("Delete this conversation?")) {
      deleteMutation.mutate({ conversationId: id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetChatHistoryQueryKey() });
          if (selectedId === id) setSelectedId(null);
        }
      });
    }
  };

  return (
    <div className="flex-1 flex overflow-hidden p-6 gap-6">
      {/* Sidebar List */}
      <div className="w-1/3 flex flex-col min-w-[300px] border border-border rounded-md bg-card overflow-hidden shadow-md">
        <div className="p-4 border-b border-border bg-muted/30">
          <h2 className="font-mono font-bold uppercase tracking-wider text-sm">Session_Log</h2>
        </div>
        <ScrollArea className="flex-1">
          {historyLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3].map(i => <div key={i} className="h-16 bg-muted animate-pulse rounded" />)}
            </div>
          ) : history?.sessions?.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground font-mono text-sm opacity-50">
              No sessions found
            </div>
          ) : (
            <div className="divide-y divide-border">
              {history?.sessions?.map(session => (
                <div 
                  key={session.conversationId}
                  onClick={() => setSelectedId(session.conversationId)}
                  className={cn(
                    "p-4 cursor-pointer hover:bg-muted/50 transition-colors flex justify-between items-start group",
                    selectedId === session.conversationId && "bg-muted"
                  )}
                >
                  <div className="overflow-hidden pr-4">
                    <div className="font-mono text-sm font-bold text-primary mb-1 truncate">
                      {session.model}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2">
                      <MessageSquare className="w-3 h-3" />
                      {session.messageCount} msgs
                      <span className="opacity-50">|</span>
                      {format(new Date(session.updatedAt), "MMM d, HH:mm")}
                    </div>
                  </div>
                  <Button 
                    variant="ghost" 
                    size="icon"
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0 h-8 w-8"
                    onClick={(e) => handleDelete(e, session.conversationId)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Detail View */}
      <div className="flex-1 flex flex-col border border-border rounded-md bg-card overflow-hidden shadow-md">
        {selectedId ? (
          convLoading ? (
            <div className="h-full flex items-center justify-center">
              <div className="animate-pulse flex flex-col items-center gap-2 text-muted-foreground">
                <span className="font-mono text-sm">LOADING_DATA...</span>
              </div>
            </div>
          ) : conversation ? (
            <>
              <div className="p-4 border-b border-border bg-muted/30 flex justify-between items-center">
                <div>
                  <h3 className="font-mono font-bold text-primary">{conversation.model}</h3>
                  <div className="text-xs text-muted-foreground font-mono mt-1">
                    ID: {conversation.conversationId}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  {format(new Date(conversation.createdAt), "yyyy-MM-dd HH:mm:ss")}
                </div>
              </div>
              <ScrollArea className="flex-1 p-6">
                <div className="space-y-6">
                  {conversation.messages.map((msg, i) => (
                    <div key={i} className="flex flex-col gap-1">
                      <div className={cn(
                        "text-xs font-mono uppercase tracking-wider",
                        msg.role === 'user' ? "text-primary" : "text-muted-foreground"
                      )}>
                        [{msg.role}]
                      </div>
                      
                      {msg.role === 'assistant' && msg.thinking && (
                        <div className="p-3 rounded-md bg-muted/20 border border-border/40 text-muted-foreground text-sm font-mono mt-1 mb-2">
                          <div className="text-xs mb-2 opacity-50 uppercase flex items-center gap-1">
                            <ChevronRight className="w-3 h-3" /> Thought Process
                          </div>
                          {msg.thinking}
                        </div>
                      )}

                      <div className={cn(
                        "p-4 rounded-md text-sm whitespace-pre-wrap font-sans",
                        msg.role === 'user' ? "bg-primary/10 border border-primary/20 text-foreground" : "bg-muted border border-border text-foreground"
                      )}>
                        {msg.content}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </>
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground font-mono text-sm">
              Session data unavailable
            </div>
          )
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground font-mono text-sm opacity-50">
            Select a session to view details
          </div>
        )}
      </div>
    </div>
  );
}
