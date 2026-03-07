export interface BuiltinProvider {
  id: string; // stable key, e.g. "openai"
  name: string;
  type: "openai" | "anthropic";
  base_url: string;
  models: string[];
}

export const builtinProviders: BuiltinProvider[] = [
  {
    id: "builtin_openai",
    name: "[内置]OpenAI",
    type: "openai",
    base_url: "https://api.openai.com/v1",
    models: [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4-turbo",
      "gpt-4",
      "gpt-3.5-turbo",
      "o1",
      "o1-mini",
      "o1-pro",
      "o3",
      "o3-mini",
      "o4-mini",
    ],
  },
  {
    id: "builtin_anthropic",
    name: "[内置]Anthropic",
    type: "anthropic",
    base_url: "https://api.anthropic.com",
    models: [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
    ],
  },
  {
    id: "builtin_zhipu",
    name: "[内置]智谱 AI",
    type: "openai",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    models: [
      "glm-4-plus",
      "glm-4-flash",
      "glm-4-long",
      "glm-4-air",
      "glm-4",
      "glm-4v-plus",
      "glm-4v",
    ],
  },
  {
    id: "builtin_minimax",
    name: "[内置]MiniMax",
    type: "anthropic",
    base_url: "https://api.minimaxi.com/anthropic",
    models: [
      "MiniMax-M1",
      "MiniMax-Text-01",
    ],
  },
  {
    id: "builtin_deepseek",
    name: "[内置]DeepSeek",
    type: "openai",
    base_url: "https://api.deepseek.com/v1",
    models: [
      "deepseek-chat",
      "deepseek-reasoner",
    ],
  },
  {
    id: "builtin_moonshot",
    name: "[内置]Moonshot (月之暗面)",
    type: "openai",
    base_url: "https://api.moonshot.cn/v1",
    models: [
      "moonshot-v1-8k",
      "moonshot-v1-32k",
      "moonshot-v1-128k",
    ],
  },
  {
    id: "builtin_qwen",
    name: "[内置]通义千问",
    type: "openai",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [
      "qwen-max",
      "qwen-plus",
      "qwen-turbo",
      "qwen-long",
      "qwen-vl-max",
      "qwen-vl-plus",
    ],
  },
  {
    id: "builtin_baichuan",
    name: "[内置]百川智能",
    type: "openai",
    base_url: "https://api.baichuan-ai.com/v1",
    models: [
      "Baichuan4",
      "Baichuan3-Turbo",
      "Baichuan3-Turbo-128k",
    ],
  },
];

export function getBuiltinProvider(id: string): BuiltinProvider | undefined {
  return builtinProviders.find((p) => p.id === id);
}
