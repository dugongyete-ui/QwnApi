import { useState } from "react";
import {
  useGetChatHistory,
  getGetChatHistoryQueryKey,
  useGetConversation,
  getGetConversationQueryKey,
  useDeleteConversation,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { MessageSquare, Trash2, ChevronRight, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

export default function History() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: history, isLoading: historyLoading } = useGetChatHistory(
    { limit: 50, offset: 0 },
    { query: { queryKey: getGetChatHistoryQueryKey() } }
  );

  const { data: conversation, isLoading: convLoading } = useGetConversation(
    selectedId || "",
    { query: { enabled: !!selectedId, queryKey: getGetConversationQueryKey(selectedId || "") } }
  );

  const deleteMutation = useDeleteConversation();

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (confirm("Delete this conversation?")) {
      deleteMutation.mutate(
        { conversationId: id },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetChatHistoryQueryKey() });
            if (selectedId === id) setSelectedId(null);
          },
        }
      );
    }
  };

  const SessionList = () => (
    <div className={cn(
      "flex flex-col border border-border rounded-md bg-card overflow-hidden shadow-md",
      // Mobile: full width when no selection, hidden when detail shown
      selectedId ? "hidden md:flex md:w-1/3 md:min-w-[280px]" : "flex flex-1",
      // Desktop: always show at fixed width
      "md:flex md:w-1/3 md:min-w-[280px] md:max-w-xs"
    )}>
      <div className="p-4 border-b border-border bg-muted/30 shrink-0">
        <h2 className="font-mono font-bold uppercase tracking-wider text-sm">Session_Log</h2>
        <p className="text-xs text-muted-foreground mt-0.5 font-mono">
          {history?.total ?? 0} sessions
        </p>
      </div>
      <ScrollArea className="flex-1">
        {historyLoading ? (
          <div className="p-4 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-muted animate-pulse rounded" />
            ))}
          </div>
        ) : history?.sessions?.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground font-mono text-sm opacity-50">
            No sessions found
          </div>
        ) : (
          <div className="divide-y divide-border">
            {history?.sessions?.map((session) => (
              <div
                key={session.conversationId}
                onClick={() => setSelectedId(session.conversationId)}
                data-testid={`session-item-${session.conversationId}`}
                className={cn(
                  "p-3 md:p-4 cursor-pointer hover:bg-muted/50 transition-colors flex justify-between items-start group",
                  selectedId === session.conversationId && "bg-muted"
                )}
              >
                <div className="overflow-hidden pr-2 flex-1">
                  <div className="font-mono text-sm font-bold text-primary mb-1 truncate">
                    {session.model}
                  </div>
                  <div className="text-xs text-muted-foreground flex items-center gap-2">
                    <MessageSquare className="w-3 h-3 shrink-0" />
                    <span>{session.messageCount} msgs</span>
                    <span className="opacity-50">|</span>
                    <span>{format(new Date(session.updatedAt), "MMM d, HH:mm")}</span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0 h-7 w-7"
                  onClick={(e) => handleDelete(e, session.conversationId)}
                  data-testid={`button-delete-${session.conversationId}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );

  const DetailView = () => (
    <div className={cn(
      "flex-1 flex flex-col border border-border rounded-md bg-card overflow-hidden shadow-md",
      // Mobile: full width when selection, hidden otherwise
      selectedId ? "flex" : "hidden md:flex"
    )}>
      {selectedId ? (
        convLoading ? (
          <div className="h-full flex items-center justify-center">
            <div className="animate-pulse flex flex-col items-center gap-2 text-muted-foreground">
              <span className="font-mono text-sm">LOADING_DATA...</span>
            </div>
          </div>
        ) : conversation ? (
          <>
            <div className="p-3 md:p-4 border-b border-border bg-muted/30 flex justify-between items-center gap-2 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                {/* Back button on mobile */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="md:hidden h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => setSelectedId(null)}
                  data-testid="button-back"
                >
                  <ArrowLeft className="w-4 h-4" />
                </Button>
                <div className="min-w-0">
                  <h3 className="font-mono font-bold text-primary text-sm">{conversation.model}</h3>
                  <div className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                    {conversation.conversationId}
                  </div>
                </div>
              </div>
              <div className="text-xs text-muted-foreground font-mono shrink-0">
                {format(new Date(conversation.createdAt), "yyyy-MM-dd HH:mm")}
              </div>
            </div>
            <ScrollArea className="flex-1 p-4 md:p-6">
              <div className="space-y-4 md:space-y-6">
                {conversation.messages.map((msg, i) => (
                  <div key={i} className="flex flex-col gap-1">
                    <div
                      className={cn(
                        "text-xs font-mono uppercase tracking-wider",
                        msg.role === "user" ? "text-primary" : "text-muted-foreground"
                      )}
                    >
                      [{msg.role}]
                    </div>

                    {msg.role === "assistant" && msg.thinking && (
                      <div className="p-3 rounded-md bg-muted/20 border border-border/40 text-muted-foreground text-xs font-mono mt-1 mb-2">
                        <div className="text-xs mb-2 opacity-50 uppercase flex items-center gap-1">
                          <ChevronRight className="w-3 h-3" /> Thought Process
                        </div>
                        {msg.thinking}
                      </div>
                    )}

                    <div
                      className={cn(
                        "p-3 md:p-4 rounded-md text-sm whitespace-pre-wrap font-sans",
                        msg.role === "user"
                          ? "bg-primary/10 border border-primary/20 text-foreground"
                          : "bg-muted border border-border text-foreground"
                      )}
                    >
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
        <div className="h-full flex flex-col items-center justify-center text-muted-foreground font-mono text-sm opacity-40 gap-2">
          <MessageSquare className="w-8 h-8" />
          <span>Select a session to view details</span>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex-1 flex overflow-hidden p-3 md:p-6 gap-3 md:gap-6">
      <SessionList />
      <DetailView />
    </div>
  );
}
