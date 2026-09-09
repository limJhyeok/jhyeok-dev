---
title: "MCP Fundamentals: Host·Client·Server부터 JSON-RPC까지"
date: 2026-09-09
category: ai
summary: MCP를 이루는 Host·Client·Server 세 역할, tools/list와 tools/call 요청의 동작, JSON-RPC 2.0과 transport 선택의 이유, 그리고 function calling과 MCP가 무엇이 다른지 정리합니다
tags: ["MCP", "JSON-RPC", "Function Calling", "LLM", "Tool Use"]
series: MCP 기초
series_order: 2
series_repo: https://github.com/limJhyeok/mcp-tutorial
---

지난 글에서는 AI에게 tool이 왜 필요한지, AI와 tool이 어떻게 소통하는지, 그리고 왜 MCP 같은 표준이 필요한지를 이야기했습니다. 이번 글에서는 **MCP fundamentals**로 한 걸음 더 들어갑니다. MCP는 무엇으로 이루어져 있고, 어떻게 동작하며, 왜 판을 바꾸는지 살펴봅니다.

## 1. 핵심 구성 요소 — Host, Client, Server

MCP의 **기본 building block**부터 시작하겠습니다. MCP는 세 가지 핵심 역할 위에 서 있습니다.

- **Host** → 모델이 살고 있는 환경입니다. 대화를 관리하는 플랫폼이라고 생각하면 됩니다.
- **Client** → host application 안에서 특정 MCP Server와의 통신을 담당하는 컴포넌트입니다.
- **Server** → tool이 있는 곳입니다. calculator, search engine, database 등 원하는 무엇이든 여기에 둡니다.

여기서 흥미로운 지점이 있습니다.

- LLM은 tool calling을 위한 **형식을 알 필요가 없습니다.**
- Server는 **어떤 LLM이 자신을 호출하는지 신경 쓰지 않습니다.**
- Host와 Client가 LLM과 MCP server 사이를 **중개합니다.**

이 분리 덕분에 MCP는 서로 다른 AI와 tool을 넘나들며 확장 가능하고 재사용 가능해집니다.

**For more information:** [MCP Specification — Architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture)

## 2. tools/list 요청

그런데 모델은 애초에 **어떤 tool이 있는지** 어떻게 알까요?

사용 가능한 tool을 발견(discover)하기 위해, client는 **`tools/list`** 요청을 보냅니다. 그러면 server가 tool 정보를 응답합니다. 여기에는 다음이 포함됩니다.

- `name`: tool 이름
- `description`: 이 tool이 무엇을 하는지
- `inputSchema`: 어떤 입력이 필요한지
- `required`: 반드시 지정해야 하는 인자

예를 들어 `get_weather` tool은 MCP에서 이렇게 생겼습니다.

**Request**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list"
}
```

**Response**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "get_weather",
        "description": "Get current weather information for a location",
        "inputSchema": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "City name or zip code"
            }
          },
          "required": ["location"]
        }
      }
    ]
  }
}
```

즉 모델은 tool을 **정확히 어떻게 호출해야 하는지**, 그리고 어떤 종류의 답이 돌아올지를 알게 됩니다. 추측도, 지저분한 파싱도 없습니다. 명확한 계약(contract)만 있을 뿐입니다.

**For more information:** [MCP Specification — Server: Tools](https://modelcontextprotocol.io/specification/2025-03-26/server/tools)

## 3. tool 호출하기

client가 특정 tool을 호출하고 싶다고 해 봅시다. 이때 client는 `tools/call` 요청을 보냅니다. tool 호출 시에는 두 가지를 지정해야 합니다. **tool 이름**과 **arguments**입니다.

**Request 예시**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": {
      "location": "New York"
    }
  }
}
```

server는 이 요청을 받아 유효한지 검사하고, 유효하다면 tool을 호출합니다. 그런 다음 결과를 담은 응답을 이렇게 돌려줍니다.

**Response 예시**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Current weather in New York:\nTemperature: 72°F\nConditions: Partly cloudy"
      }
    ],
    "isError": false
  }
}
```

이런 방식으로 client와 server는 매끄럽게 통신할 수 있습니다.

### 한 session의 전체 흐름

지금까지 본 조각들을 시간 순서로 늘어놓으면 이렇게 됩니다. 다음 글에서 Python으로 작성할 코드가 실제로 주고받는 메시지들입니다.

```text
Client                                   Server
  │                                        │
  ├──  initialize  ──────────────────────► │   protocol version, 지원 기능 교환
  │ ◄──────────────────  server 정보  ──── │
  │                                        │
  ├──  tools/list  ──────────────────────► │   "어떤 tool이 있나요?"
  │ ◄─────────  tool 목록 + schema  ────── │
  │                                        │
  │  (LLM이 이 목록을 보고 무엇을 부를지 결정)
  │                                        │
  ├──  tools/call  ──────────────────────► │   name + arguments
  │ ◄──────────────  실행 결과  ────────── │
  │                                        │
```

**`initialize` → `tools/list` → `tools/call`**, 이 세 단계가 MCP 상호작용의 뼈대입니다. `initialize`는 연결마다 한 번, `tools/list`는 보통 시작할 때 한 번, `tools/call`은 필요할 때마다 반복됩니다.

## 4. Protocol 동작 원리 — JSON-RPC 2.0

이제 **MCP가 내부적으로 실제로 어떻게 동작하는지** 이야기해 봅시다.

MCP는 custom API나 import 대신 **JSON-RPC 2.0**을 사용합니다. MCP client와 server는 JSON 형식과 가벼운 JSON-RPC 2.0 protocol을 통해 request와 response로 통신합니다. 이 설계 선택이 MCP를 대단히 유연하게 만듭니다. 왜 이런 선택을 했는지, 요구사항부터 짚어 보겠습니다.

**1. tool 호출은 client-server 시스템처럼 동작한다**

지난 글에서는 local python function만 이야기했습니다. 하지만 tool이 꼭 local python function일 필요는 없습니다. tool은 외부 API일 수도 있습니다. AI가 tool에 구조화된 요청을 보내면, tool은 그 요청에 따라 결과를 만들고, LLM은 그 결과를 받아 응답 생성을 이어 갑니다.

**2. 기존 tool을 쉽게 쓰고 싶다**

방금 말했듯 tool은 local function일 필요가 없습니다. 인터넷으로 연결할 수 있는 어떤 API든 될 수 있습니다. 그렇다면 MCP 같은 표준 tool 규약은 local의 standard input/output뿐 아니라 **네트워크 통신도 지원해야 합니다.**

**3. streaming을 원한다**

많은 사용자가 실시간 결과를 원합니다. 대부분의 LLM은 텍스트를 token 단위로 생성하므로, 전체 응답이 완성될 때까지 기다리고 싶지 않습니다.

**4. tool 개발자는 복잡한 API server를 만들고 싶어 하지 않는다**

요즘은 web server를 만드는 게 예전보다 쉬워졌다지만, 여전히 번거로운 일입니다. 대부분의 개발자는 tool의 입력·출력 형식을 정의하고, 실행하고, AI와 잘 동작하기만 하면 됩니다. 본격적인 HTTP endpoint, routing, server 관리까지 떠안고 싶지는 않습니다.

MCP는 tool이 **공통 protocol인 JSON-RPC 2.0**을 말하게 함으로써 이 문제를 해결합니다. 덕분에 어떤 tool이든 web server가 되지 않고도 AI와 통신할 수 있습니다. 구조화된 요청을 받고 구조화된 응답을 돌려줄 방법만 있으면 됩니다. 이 덕분에 개발자는 tool을 훨씬 쉽게 만들고 공유할 수 있으며, tool이 로컬에서 돌든 다른 머신에서 돌든 클라우드에 있든 AI는 안정적으로 상호작용할 수 있습니다.

### transport 선택지

이런 요구를 충족하기 위해 MCP는 **JSON-RPC 2.0** protocol을 택했고, 여러 transport를 지원합니다.

- **stdio** (standard input/output) → local tool에 적합합니다.
- **Streamable HTTP** → 네트워크로 연결되는 tool에 적합합니다.
  - 과거에는 streamable HTTP를 쓸 수 없었습니다. 인터넷 protocol과 함께 동작하기 위해 MCP는 **stdio + SSE(Server-Sent Events)** 를 사용했습니다. 이후 이 방식은 streamable HTTP로 대체되었습니다. 변경 배경이 궁금하다면 [MCP GitHub issue #206](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/206)을 확인해 보세요.

이 설계 선택이 MCP를 더 보편적인 것으로 만듭니다.

**For more information**

- [MCP Specification — Transports](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [ChatGPT 대화 기록](https://chatgpt.com/share/68b186bd-c728-8010-8ed4-128e7454f0d9)
- [modelcontextprotocol PR #206](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/206)
- [JSON-RPC 정리 글](https://mangkyu.tistory.com/442)

## 5. Function Calling과의 관계

여기까지 보고 나면 이런 생각이 들 수 있습니다. "잠깐, 이거 그냥 **function calling** 아니야?"

정확히는 아닙니다. 왜 MCP가 판을 바꾸는지 설명해 보겠습니다.

GPT 같은 모델의 function calling은 훌륭하지만 **플랫폼에 묶여 있습니다.** OpenAI는 자기만의 function 형식을 정의하고, Anthropic은 또 다른 형식을 정의하는 식입니다.

MCP는 여기서 한 걸음 더 나아갑니다. **feature가 아니라 protocol이기 때문입니다.** MCP는 tool 정의, 발견(discovery), 통신을 모든 모델과 host에서 통하는 방식으로 표준화합니다. 플랫폼마다 같은 function 정의를 다시 쓰는 대신, MCP는 보편적인 계층을 제공합니다.

그런데 여기서 흥미로워지는 부분이 있습니다. 도입(adoption) 이야기에는 두 가지 면이 있고, 당신이 **end user**인지 **앱을 만드는 개발자**인지에 따라 경험이 꽤 다릅니다.

### end user와 desktop tool 입장에서는 아주 매끄럽다

**Claude Desktop** — JSON config 파일을 복사·붙여넣기 하면 끝입니다. "Edit Config" 버튼을 눌러 설정 파일을 엽니다.

![Claude Desktop의 Settings 창. 왼쪽 사이드바에 General과 Developer 탭이 있고 Developer가 선택되어 있으며, 오른쪽에는 MCP가 Claude Desktop 앱 같은 client와 로컬 서비스 사이의 안전한 연결을 가능하게 하는 protocol이라는 설명과 함께 Edit Config, Get Started 두 개의 버튼이 놓여 있다](/images/mcp-fundamentals/claude-desktop-edit-config.png)

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "C:\\Users\\username\\Desktop",
        "C:\\Users\\username\\Downloads"
      ]
    }
  }
}
```

**Claude Code** — 마찬가지로 아주 간단합니다.

```bash
# claude code MCP connector for sse transport

# Basic syntax
claude mcp add --transport sse <name> <url>

# Real example: Connect to Linear
claude mcp add --transport sse linear https://mcp.linear.app/sse

# Example with authentication header
claude mcp add --transport sse private-api https://api.company.com/mcp \
  --header "X-API-Key: your-key-here"
```

**Cursor IDE**도 다르지 않습니다.

**For more information**

- [MCP Quickstart — For Users](https://modelcontextprotocol.io/quickstart/user)
- [Claude Code — Add a remote SSE server](https://docs.anthropic.com/en/docs/claude-code/mcp#option-2%3A-add-a-remote-sse-server)
- [Cursor — MCP protocol support](https://docs.cursor.com/en/context/mcp#protocol-support)
- [Azure AI Foundry — MCP와 Azure OpenAI 통합](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/model-context-protocol-mcp-integrating-azure-openai-for-enhanced-tool-integratio/4393788)

### 하지만 API로 앱을 만드는 개발자라면 이야기가 복잡해진다

지금은 많은 AI provider가 MCP를 지원합니다. 다만 아직 형식이 조금씩 다릅니다.

**OpenAI API MCP connector**

```python
from openai import OpenAI

client = OpenAI()

resp = client.responses.create(
    model="gpt-5",
    tools=[
        {
            "type": "mcp",
            "server_label": "dmcp",
            "server_description": "A Dungeons and Dragons MCP server to assist with dice rolling.",
            "server_url": "https://dmcp-server.deno.dev/sse",
            "require_approval": "never",
        },
    ],
    input="Roll 2d4+1",
)

print(resp.output_text)
```

**Claude API MCP connector**

```python
import anthropic

client = anthropic.Anthropic()

response = client.beta.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1000,
    messages=[{
        "role": "user",
        "content": "What tools do you have available?"
    }],
    mcp_servers=[{
        "type": "url",
        "url": "https://mcp.example.com/sse",
        "name": "example-mcp",
        "authorization_token": "YOUR_TOKEN"
    }],
    betas=["mcp-client-2025-04-04"]
)
```

정리하면 현재 상태는 이렇습니다. Claude나 Cursor 같은 desktop app을 쓰는 입장이라면 MCP 설정은 아주 쉽습니다. 말 그대로 config 파일을 복사·붙여넣기 하면 끝입니다. 하지만 자신의 AI 앱을 직접 만드는 개발자라면, 여전히 MCP 통합을 위한 코드를 작성해야 합니다. server 연결 설정, 인증 관리, 응답 처리 같은 기술적인 일들이 남아 있습니다.

다행인 점은 주요 개발자 도구들이 이 간극을 메우고 있다는 것입니다. 예를 들어 LangChain은 복잡한 통합 작업을 대신 처리해 주는 MCP adapter를 제공합니다. 수십 줄의 설정 코드를 직접 쓰는 대신 미리 만들어진 connector를 쓰고, 실제로 만들려는 앱에 집중할 수 있습니다.

**For more information**

- [OpenAI — Tools & connectors (MCP)](https://platform.openai.com/docs/guides/tools-connectors-mcp?quickstart-panels=remote-mcp)
- [OpenAI Agents Python — MCP](https://openai.github.io/openai-agents-python/mcp/)
- [Anthropic — MCP connector](https://docs.anthropic.com/ko/docs/agents-and-tools/mcp-connector)
- [langchain-mcp-adapters](https://github.com/langchain-ai/langchain-mcp-adapters)

## 정리

- MCP는 **Host, Client, Server** 세 역할 위에 세워져 있다
- MCP Client는 `tools/list` 요청으로 어떤 tool이 있는지와 그 spec을 알아낸다
- Client는 `tools/call` 요청으로 MCP server의 tool을 호출한다
- MCP는 **JSON-RPC** 위에서 동작하며, 최대한의 유연성을 위해 **stdio / Streamable HTTP** transport를 지원한다
- 그리고 모든 것을 표준화함으로써 단순한 function calling을 넘어선다

다음 글에서는 실제 코드 예제와 함께 **MCP가 동작하는 모습**을 살펴보겠습니다.
