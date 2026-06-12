import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Copy, Check, Play, ChevronDown, ChevronUp, Globe } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const BASE_URL = `${window.location.protocol}//${window.location.host}`;

interface Param {
  name: string;
  type: string;
  required?: boolean;
  description: string;
  defaultValue?: string;
}

interface EndpointDef {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  description: string;
  auth?: boolean;
  params?: Param[];
  bodySchema?: string;
  exampleBody?: string;
  exampleResponse?: string;
  pathParams?: Param[];
}

const ENDPOINT_GROUPS: { title: string; description: string; endpoints: EndpointDef[] }[] = [
  {
    title: "API Endpoints",
    description: "Endpoint utama yang paling sering digunakan. Kompatibel dengan OpenAI SDK.",
    endpoints: [
      {
        method: "POST",
        path: "/v1/chat/completions",
        description: "Kirim pesan ke model Qwen dan terima balasan. Mendukung streaming, vision, dan tool calling.",
        auth: true,
        bodySchema: `{
  "model": "qwen-plus" | "qwen-max" | "qwen3-235b-a22b",
  "messages": [{ "role": "user" | "assistant" | "system", "content": string }],
  "stream": boolean (optional),
  "temperature": number (optional),
  "max_tokens": number (optional)
}`,
        exampleBody: JSON.stringify(
          {
            model: "qwen-plus",
            messages: [{ role: "user", content: "Hello! What can you do?" }],
            stream: false,
          },
          null,
          2
        ),
        exampleResponse: JSON.stringify(
          {
            id: "chatcmpl-abc123",
            object: "chat.completion",
            model: "qwen-plus",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "I'm Qwen, an AI assistant..." },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
          },
          null,
          2
        ),
      },
      {
        method: "GET",
        path: "/v1/models",
        description: "Daftar semua model Qwen yang tersedia dan bisa digunakan di chat completions.",
        auth: true,
        exampleResponse: JSON.stringify(
          {
            object: "list",
            data: [
              { id: "qwen-plus", object: "model" },
              { id: "qwen-max", object: "model" },
              { id: "qwen3-235b-a22b", object: "model" },
            ],
          },
          null,
          2
        ),
      },
      {
        method: "GET",
        path: "/api/healthz",
        description: "Cek status server. Mengembalikan 200 OK jika server sedang berjalan.",
        exampleResponse: JSON.stringify({ status: "ok", uptime: 3600 }, null, 2),
      },
    ],
  },
];

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  POST: "bg-green-500/10 text-green-400 border-green-500/30",
  PATCH: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
  DELETE: "bg-red-500/10 text-red-400 border-red-500/30",
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast({ title: "Copied!" });
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function EndpointCard({ endpoint, globalApiKey }: { endpoint: EndpointDef; globalApiKey: string }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(endpoint.exampleBody ?? "");
  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [response, setResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [responseStatus, setResponseStatus] = useState<number | null>(null);
  const { toast } = useToast();

  const buildUrl = () => {
    let path = endpoint.path;
    for (const [key, val] of Object.entries(pathValues)) {
      path = path.replace(`:${key}`, val || `:${key}`);
    }
    return `${BASE_URL}${path}`;
  };

  const handleExecute = async () => {
    setLoading(true);
    setResponse(null);
    try {
      const url = buildUrl();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (endpoint.auth && globalApiKey) {
        headers["Authorization"] = `Bearer ${globalApiKey}`;
      }
      const res = await fetch(url, {
        method: endpoint.method,
        headers,
        body: ["POST", "PATCH"].includes(endpoint.method) ? body : undefined,
      });
      setResponseStatus(res.status);
      const text = await res.text();
      try {
        setResponse(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        setResponse(text);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setResponse(`Error: ${msg}`);
      toast({ title: "Request failed", description: msg, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const curlExample = (() => {
    let path = endpoint.path;
    for (const [key, val] of Object.entries(pathValues)) {
      path = path.replace(`:${key}`, val || `{${key}}`);
    }
    const authFlag = endpoint.auth ? ` \\\n  -H "Authorization: Bearer YOUR_API_KEY"` : "";
    const bodyFlag =
      ["POST", "PATCH"].includes(endpoint.method) && body
        ? ` \\\n  -d '${body.replace(/\n\s*/g, " ")}'`
        : "";
    return `curl -X ${endpoint.method} "${BASE_URL}${path}" \\
  -H "Content-Type: application/json"${authFlag}${bodyFlag}`;
  })();

  return (
    <Card className="border-border bg-card overflow-hidden">
      <button
        className="w-full text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <CardHeader className="p-4 hover:bg-muted/30 transition-colors">
          <div className="flex items-center gap-3">
            <Badge
              variant="outline"
              className={cn(
                "font-mono text-xs font-bold w-14 justify-center shrink-0",
                METHOD_COLORS[endpoint.method]
              )}
            >
              {endpoint.method}
            </Badge>
            <code className="font-mono text-sm text-primary flex-1 truncate">{endpoint.path}</code>
            {endpoint.auth && (
              <Badge variant="outline" className="text-xs font-mono shrink-0 hidden sm:inline-flex border-yellow-500/30 text-yellow-400 bg-yellow-500/5">
                AUTH
              </Badge>
            )}
            {open ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1.5 text-left">{endpoint.description}</p>
        </CardHeader>
      </button>

      {open && (
        <CardContent className="px-4 pb-4 pt-0 border-t border-border space-y-4">
          {/* Path params */}
          {endpoint.pathParams && endpoint.pathParams.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-mono uppercase text-muted-foreground tracking-widest">Path Parameters</p>
              {endpoint.pathParams.map((p) => (
                <div key={p.name} className="flex flex-col sm:flex-row gap-2 sm:items-center">
                  <div className="flex items-center gap-2 sm:w-48 shrink-0">
                    <code className="text-xs font-mono text-primary">{p.name}</code>
                    {p.required && <span className="text-destructive text-xs">*</span>}
                    <span className="text-xs text-muted-foreground">({p.type})</span>
                  </div>
                  <Input
                    placeholder={p.description}
                    value={pathValues[p.name] ?? ""}
                    onChange={(e) => setPathValues((v) => ({ ...v, [p.name]: e.target.value }))}
                    className="h-7 text-xs font-mono bg-background"
                  />
                </div>
              ))}
            </div>
          )}

          {/* Body */}
          {["POST", "PATCH"].includes(endpoint.method) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-mono uppercase text-muted-foreground tracking-widest">Request Body</p>
                {endpoint.bodySchema && (
                  <span className="text-xs text-muted-foreground font-mono hidden sm:block">{endpoint.bodySchema}</span>
                )}
              </div>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="font-mono text-xs bg-background min-h-[100px] resize-y"
                placeholder="{}"
              />
            </div>
          )}

          {/* Execute */}
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1 bg-background border border-border rounded-md px-3 py-2 font-mono text-xs text-muted-foreground truncate">
              {buildUrl()}
            </div>
            <Button
              onClick={handleExecute}
              disabled={loading}
              size="sm"
              className="font-mono uppercase tracking-wider text-xs shrink-0"
            >
              <Play className="w-3.5 h-3.5 mr-1.5" />
              {loading ? "Sending..." : "Execute"}
            </Button>
          </div>

          {/* Response */}
          {response !== null && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-mono uppercase text-muted-foreground tracking-widest">Response</p>
                  {responseStatus !== null && (
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-xs font-mono",
                        responseStatus < 300
                          ? "text-green-400 border-green-500/30 bg-green-500/10"
                          : "text-red-400 border-red-500/30 bg-red-500/10"
                      )}
                    >
                      {responseStatus}
                    </Badge>
                  )}
                </div>
                <CopyButton text={response} />
              </div>
              <pre className="bg-background border border-border rounded-md p-3 text-xs font-mono overflow-auto max-h-64 text-foreground/80">
                {response}
              </pre>
            </div>
          )}

          {/* cURL example */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-mono uppercase text-muted-foreground tracking-widest">cURL</p>
              <CopyButton text={curlExample} />
            </div>
            <pre className="bg-background border border-border rounded-md p-3 text-xs font-mono overflow-auto text-foreground/60 whitespace-pre-wrap">
              {curlExample}
            </pre>
          </div>

          {/* Example response */}
          {endpoint.exampleResponse && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-mono uppercase text-muted-foreground tracking-widest">Example Response</p>
                <CopyButton text={endpoint.exampleResponse} />
              </div>
              <pre className="bg-background border border-border rounded-md p-3 text-xs font-mono overflow-auto max-h-48 text-foreground/60">
                {endpoint.exampleResponse}
              </pre>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default function ApiReference() {
  const [apiKey, setApiKey] = useState("");
  const [copiedBaseUrl, setCopiedBaseUrl] = useState(false);
  const { toast } = useToast();

  const handleCopyBaseUrl = () => {
    navigator.clipboard.writeText(BASE_URL);
    setCopiedBaseUrl(true);
    toast({ title: "Base URL copied!" });
    setTimeout(() => setCopiedBaseUrl(false), 2000);
  };

  return (
    <div className="flex-1 overflow-auto p-4 md:p-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">API Reference</h1>
        <p className="text-muted-foreground font-mono text-xs md:text-sm mt-1">
          Interactive documentation for the Qwen Gateway API.
        </p>
      </div>

      {/* Base URL + Auth */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="border-border bg-card">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs font-mono uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <Globe className="w-3.5 h-3.5" /> Base URL
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="flex items-center gap-2 bg-background border border-primary/30 rounded-md px-3 py-2">
              <code className="text-primary font-mono text-sm flex-1 truncate">{BASE_URL}</code>
              <button
                onClick={handleCopyBaseUrl}
                className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground shrink-0"
              >
                {copiedBaseUrl ? (
                  <Check className="w-3.5 h-3.5 text-green-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-2 font-mono">
              Use this as the base URL in any OpenAI-compatible SDK.
            </p>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs font-mono uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <span className="text-yellow-400">⚿</span> Authentication
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-2">
            <Label htmlFor="api-key-input" className="text-xs font-mono text-muted-foreground">
              API Key (for testing AUTH endpoints)
            </Label>
            <Input
              id="api-key-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-gw-xxxxxxxxxxxxxxxx"
              className="font-mono text-xs bg-background h-9"
            />
            <p className="text-xs text-muted-foreground font-mono">
              Passed as <code className="text-primary">Authorization: Bearer &lt;key&gt;</code>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* SDK Quick Start */}
      <Card className="border-border bg-card">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
            Quick Start — OpenAI SDK
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground font-mono">Python</p>
                <CopyButton
                  text={`from openai import OpenAI\n\nclient = OpenAI(\n    api_key="YOUR_API_KEY",\n    base_url="${BASE_URL}/v1"\n)\n\nresponse = client.chat.completions.create(\n    model="qwen-plus",\n    messages=[{"role": "user", "content": "Hello!"}]\n)`}
                />
              </div>
              <pre className="bg-background border border-border rounded-md p-3 text-xs font-mono text-foreground/70 overflow-auto">{`from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="${BASE_URL}/v1"
)

response = client.chat.completions.create(
    model="qwen-plus",
    messages=[{"role": "user", "content": "Hello!"}]
)`}</pre>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground font-mono">JavaScript / Node.js</p>
                <CopyButton
                  text={`import OpenAI from "openai";\n\nconst client = new OpenAI({\n  apiKey: "YOUR_API_KEY",\n  baseURL: "${BASE_URL}/v1",\n});\n\nconst res = await client.chat.completions.create({\n  model: "qwen-plus",\n  messages: [{ role: "user", content: "Hello!" }],\n});`}
                />
              </div>
              <pre className="bg-background border border-border rounded-md p-3 text-xs font-mono text-foreground/70 overflow-auto">{`import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "YOUR_API_KEY",
  baseURL: "${BASE_URL}/v1",
});

const res = await client.chat.completions.create({
  model: "qwen-plus",
  messages: [{ role: "user", content: "Hello!" }],
});`}</pre>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Endpoint Groups */}
      {ENDPOINT_GROUPS.map((group) => (
        <div key={group.title} className="space-y-3">
          <div>
            <h2 className="text-lg font-bold font-mono tracking-tight">{group.title}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{group.description}</p>
          </div>
          <div className="space-y-2">
            {group.endpoints.map((ep) => (
              <EndpointCard key={`${ep.method}-${ep.path}`} endpoint={ep} globalApiKey={apiKey} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
