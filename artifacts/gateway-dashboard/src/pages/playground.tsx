import { useState, useRef, useEffect } from "react";
import { useSendChat, useListModels, getListModelsQueryKey } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Terminal, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatMessage, ChatMessageRole } from "@workspace/api-client-react/src/generated/api.schemas";

export default function Playground() {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<string>("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: modelsData } = useListModels({
    query: { queryKey: getListModelsQueryKey() }
  });

  const sendChat = useSendChat();

  useEffect(() => {
    if (modelsData?.models?.length && !model) {
      setModel(modelsData.models[0].id);
    }
  }, [modelsData, model]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || sendChat.isPending) return;

    const userMessage: ChatMessage = {
      role: "user",
      content: prompt,
      timestamp: new Date().toISOString()
    };

    setMessages(prev => [...prev, userMessage]);
    setPrompt("");

    sendChat.mutate({
      data: {
        prompt: userMessage.content,
        model,
        conversationId: conversationId || undefined
      }
    }, {
      onSuccess: (res) => {
        setConversationId(res.conversationId);
        setMessages(prev => [...prev, {
          role: "assistant",
          content: res.response,
          thinking: res.thinking,
          timestamp: new Date().toISOString()
        }]);
      }
    });
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden p-6 gap-4">
      <div className="flex justify-between items-center shrink-0">
        <h1 className="text-2xl font-bold tracking-tight font-mono flex items-center gap-2">
          <Terminal className="h-6 w-6 text-primary" />
          TEST_CLIENT
        </h1>
        <div className="w-64">
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="font-mono bg-card">
              <SelectValue placeholder="Select model..." />
            </SelectTrigger>
            <SelectContent>
              {modelsData?.models?.map(m => (
                <SelectItem key={m.id} value={m.id} className="font-mono">{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="flex-1 flex flex-col overflow-hidden bg-card border-border rounded-md shadow-md">
        <ScrollArea className="flex-1 p-4" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50">
              <Cpu className="w-16 h-16 mb-4 text-primary opacity-20" />
              <p className="font-mono text-sm uppercase tracking-widest">Awaiting Input</p>
            </div>
          ) : (
            <div className="space-y-6">
              {messages.map((msg, i) => (
                <div key={i} className={cn("flex flex-col max-w-[85%]", msg.role === 'user' ? "ml-auto items-end" : "mr-auto items-start")}>
                  <div className="text-xs text-muted-foreground font-mono mb-1 uppercase opacity-70">
                    {msg.role}
                  </div>
                  
                  {msg.role === 'assistant' && msg.thinking && (
                    <div className="mb-2 p-3 rounded-md bg-muted/30 border border-border/50 text-muted-foreground text-sm font-mono w-full">
                      <div className="text-xs mb-1 opacity-50 uppercase">&gt; System Thought Process</div>
                      {msg.thinking}
                    </div>
                  )}

                  <div className={cn(
                    "p-3 rounded-md text-sm",
                    msg.role === 'user' ? "bg-primary text-primary-foreground" : "bg-muted border border-border text-foreground"
                  )}>
                    <div className="whitespace-pre-wrap font-sans">{msg.content}</div>
                  </div>
                </div>
              ))}
              {sendChat.isPending && (
                <div className="flex flex-col mr-auto items-start max-w-[85%]">
                  <div className="text-xs text-muted-foreground font-mono mb-1 uppercase opacity-70">
                    assistant
                  </div>
                  <div className="p-3 rounded-md bg-muted border border-border text-foreground flex gap-1">
                    <span className="animate-bounce inline-block w-1.5 h-1.5 bg-primary rounded-full" style={{animationDelay: "0ms"}}/>
                    <span className="animate-bounce inline-block w-1.5 h-1.5 bg-primary rounded-full" style={{animationDelay: "150ms"}}/>
                    <span className="animate-bounce inline-block w-1.5 h-1.5 bg-primary rounded-full" style={{animationDelay: "300ms"}}/>
                  </div>
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        <div className="p-4 border-t border-border bg-background/50">
          <form onSubmit={handleSubmit} className="flex gap-2">
            <Input 
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="Enter prompt..."
              className="font-mono bg-card"
              disabled={sendChat.isPending}
            />
            <Button type="submit" disabled={sendChat.isPending || !prompt.trim()} size="icon">
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
