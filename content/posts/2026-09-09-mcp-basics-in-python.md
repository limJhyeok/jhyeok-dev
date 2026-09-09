---
title: "Python으로 MCP 시작하기: stdio·streamable HTTP server와 client"
date: 2026-09-09
category: ai
summary: FastMCP로 calculator MCP server를 만들고 stdio client로 tools/list·tools/call을 실행해 보며, streamable HTTP transport로 확장하는 과정까지 코드로 따라갑니다
tags: ["MCP", "FastMCP", "Python", "stdio", "Streamable HTTP"]
series: MCP 기초
series_order: 3
series_repo: https://github.com/limJhyeok/mcp-tutorial
---

지난 글까지 MCP가 무엇이고 왜 중요한지 살펴봤습니다. 개념은 충분히 다뤘으니, 이번에는 실제로 무언가를 만들어 보겠습니다.

이 글에서는 Python으로 간단한 MCP server와 client를 만듭니다. 데모 server에는 **calculator** tool을 넣어, 조각들이 어떻게 맞물리는지 직접 손으로 확인해 봅니다. 이 글의 모든 코드는 그대로 복사해서 실행하면 동작합니다.

## 0. 실습 환경 준비

Python 패키지 관리자로 [uv](https://docs.astral.sh/uv/getting-started/installation/)를 사용하겠습니다. `pip`이나 `poetry`를 쓰셔도 무방합니다.

```bash
# uv 설치 (macOS/Linux)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 프로젝트 생성
uv init mcp-tutorial && cd mcp-tutorial
uv add "mcp[cli]"
```

`mcp[cli]`가 server와 client에 필요한 Python SDK를 모두 포함합니다. 이 글에서 만들 파일은 딱 네 개입니다.

```text
mcp-tutorial/
├── servers/
│   ├── stdio_servers/calculator.py       # 1~2장
│   └── streamable_http_servers/greet.py  # 5장
└── clients/
    ├── stdio_client.py                   # 3~4장
    └── streamable_client.py              # 6장
```

## 1. MCP stdio server 준비하기

먼저 Python MCP SDK로 server를 세팅합니다. 가장 단순한 transport인 **stdio**로 시작하겠습니다. server가 standard input/output으로 client와 통신한다는 뜻이고, 데모와 테스트에는 이게 가장 편합니다.

MCP stdio server를 세팅하는 방법은 여러 가지지만, 입문자에게 가장 간단한 `FastMCP` 클래스를 쓰겠습니다.

```python
# servers/stdio_servers/calculator.py
from mcp.server.fastmcp import FastMCP

mcp = FastMCP(
    name="Calculator",
)
```

`FastMCP`를 import하고 원하는 이름으로 인스턴스를 만드는 것, 이게 전부입니다.

## 2. Tool 정의하기 (calculator 예제)

다음으로 tool을 추가합니다. tool은 그저 server에 등록해서 client가 호출할 수 있게 만든 함수입니다. `@mcp.tool()` decorator를 붙이면 끝입니다.

```python
# servers/stdio_servers/calculator.py (이어서)

@mcp.tool("add")
def add(a: int, b: int) -> int:
    """
    Adds two integers together.

    Args:
        a (int): The first number.
        b (int): The second number.

    Returns:
        int: The sum of a and b.
    """
    return a + b


@mcp.tool("subtract")
def subtract(a: int, b: int) -> int:
    return a - b


@mcp.tool("divide")
def divide(a: int, b: int) -> float:
    if b == 0:
        raise ValueError("Division by zero is not allowed")
    return a / b


@mcp.tool("multiply")
def multiply(a: int, b: int) -> int:
    return a * b


if __name__ == "__main__":
    mcp.run()
```

꽤 단순합니다. tool 네 개를 등록했고, 각 tool은 숫자를 받아 결과를 돌려줄 뿐입니다.

`@mcp.tool("add")`처럼 이름을 넘기면 그 이름으로 등록되고, `@mcp.tool()`처럼 비워 두면 함수 이름이 그대로 tool 이름이 됩니다. 위 코드에서는 함수 이름과 tool 이름이 어차피 같으니 어느 쪽을 써도 결과는 같습니다.

여기서 눈여겨볼 점은 **우리가 JSON schema를 한 줄도 쓰지 않았다는 것**입니다. `a: int`, `b: int`, `-> int` 같은 type hint와 docstring만으로 FastMCP가 지난 글에서 본 `inputSchema`를 자동으로 만들어 줍니다. 잠시 뒤 client를 실행하면 실제로 확인할 수 있습니다.

### tool을 만들 때 중요한 팁

**1. 입력·출력 타입을 명시하세요.**

Python은 type hint를 요구하지 않지만, 이 tool들은 **LLM이 사용합니다.** 타입을 명시하면 모델이 무엇을 보내야 하는지 이해하는 데 도움이 됩니다. 예를 들어 `add`가 정수를 기대한다는 걸 알려주지 않으면 LLM이 문자열을 넘길 수도 있습니다. 예상치 못한 결과로 이어지고, 우리가 피하고 싶은 상황입니다.

**2. tool을 설명하는 명확한 docstring을 쓰세요.**

ChatGPT에게 무언가를 물어볼 때와 마찬가지로, 이 tool이 무엇을 하고 왜 존재하는지 자세히 설명하는 게 도움이 됩니다. **docstring은 그대로 LLM에게 전달되므로**, 모델은 함수를 **언제 어떻게** 쓸지 쉽게 이해할 수 있습니다. 주석 작성 팁은 이렇습니다.

- 포괄적인 tool description을 작성하기
- parameter를 상세히 문서화하기
- docstring에 사용 예시를 포함하기

위 코드에서 `add`에만 docstring을 쓰고 나머지 셋은 비워 둔 것은 의도적입니다. 다음 장에서 client를 실행하면 그 차이가 눈에 보입니다.

**3. 에러를 우아하게 처리하세요.**

- 사람과 마찬가지로, LLM도 에러를 이해하면 자기 실수를 스스로 고칠 수 있습니다.
- 명확한 에러 메시지는 LLM이 문제를 파악하고 고치도록 돕습니다 (database connection error, division by zero, API key error 등).
- 위 `divide`가 `ValueError("Division by zero is not allowed")`를 던지면, 이 메시지는 `isError: true`와 함께 client에게 전달되어 LLM이 읽고 다시 시도할 수 있습니다.

**4. 설명적인 이름을 고르세요.**

naming은 중요합니다. 명확하고 의미 있는 이름은 나와 LLM 모두가 tool의 목적을 이해하도록 돕습니다.

이제 server 설정이 끝났고, MCP client의 요청을 받을 준비가 되었습니다.

## 3. MCP stdio client 준비하기

server가 준비되었으니, Python client에서 이 tool들을 실제로 어떻게 호출하는지 보겠습니다. 먼저 stdio MCP server를 위한 파라미터를 설정합니다.

```python
# clients/stdio_client.py
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
import asyncio

server_params = StdioServerParameters(
    command="uv",
    args=["run", "servers/stdio_servers/calculator.py"],
)
```

`StdioServerParameters`로 Python에게 server를 어떻게 띄울지 알려주는 것입니다.

- `command`는 server를 시작하기 위해 평소 터미널에서 실행할 명령어입니다.
- `args`는 server 스크립트를 실행하는 데 필요한 추가 인자입니다.

> **여기서 헷갈리기 쉬운 점 하나.** stdio transport에서는 **server를 따로 실행해 둘 필요가 없습니다.** 위 `command`와 `args`를 보고 client가 server를 **자식 프로세스로 직접 띄우고**, 그 프로세스의 stdin/stdout에 JSON-RPC 메시지를 주고받습니다. client가 끝나면 server도 함께 종료됩니다. 터미널은 하나면 충분합니다.

server 파라미터가 준비되면 `stdio_client`로 server에 비동기적으로 연결할 수 있습니다. non-blocking 호출을 원하거나 다른 async 코드와 잘 어울리게 하고 싶을 때 유용합니다.

```python
async def run():
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            # Initialise session
            await session.initialize()


if __name__ == "__main__":
    asyncio.run(run())
```

단계별로 무슨 일이 벌어지는지 보면,

- `stdio_client(server_params)`가 server 프로세스를 띄우고 읽기/쓰기 stream 한 쌍을 돌려줍니다.
- `ClientSession(read, write)`가 그 stream 위에서 요청을 보내고 응답을 받기 위한 session을 만듭니다.
- `await session.initialize()`가 protocol version과 지원 기능을 교환하는 handshake를 수행합니다. 이걸 빼먹으면 이후 요청이 실패합니다.

여기서부터 등록된 어떤 tool이든 이 session을 통해 호출할 수 있습니다.

## 4. MCP client에서 server의 tool 호출하기

지금 코드는 별것 없어 보이지만, 이미 async client가 MCP server에 연결된 상태입니다. 이제 server에 어떤 tool이 있고 그 세부 정보가 무엇인지 확인해 봅시다.

```python
async def run():
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            # 1) tools/list — server에 어떤 tool이 있는지 물어본다
            tools = await session.list_tools()
            for tool in tools.tools:
                print(
                    f"Tool Name: {tool.name}\n"
                    f"Description: {tool.description}\n"
                    f"Input Schema: {tool.inputSchema}\n"
                )

            # 2) tools/call — 'add' tool을 실제로 호출한다
            result = await session.call_tool("add", {"a": 5, "b": 3})
            print("Add result:", result)
```

여기서 벌어지는 일은,

- `await session.list_tools()`가 지난 글에서 본 **`tools/list` 요청**을 보내 server에 등록된 모든 tool을 가져옵니다.
- 각 tool을 돌면서 이름, description, input schema를 출력합니다.
- 마지막으로 `session.call_tool()`이 **`tools/call` 요청**을 보내 `add` tool을 호출하고 결과를 받아 옵니다.

### 실행해 보기

```bash
uv run clients/stdio_client.py
```

실제 출력입니다. (지면상 `add`와 `subtract`만 옮깁니다)

```text
Tool Name: add
Description:
Adds two integers together.

Args:
    a (int): The first number.
    b (int): The second number.

Returns:
    int: The sum of a and b.

Input Schema: {'properties': {'a': {'title': 'A', 'type': 'integer'},
                              'b': {'title': 'B', 'type': 'integer'}},
               'required': ['a', 'b'],
               'title': 'addArguments', 'type': 'object'}

Tool Name: subtract
Description:
Input Schema: {'properties': {'a': {'title': 'A', 'type': 'integer'},
                              'b': {'title': 'B', 'type': 'integer'}},
               'required': ['a', 'b'],
               'title': 'subtractArguments', 'type': 'object'}

Add result: content=[TextContent(type='text', text='8')]
            structuredContent={'result': 8} isError=False
```

읽어 낼 것이 세 가지 있습니다.

**첫째, type hint가 그대로 JSON schema가 되었습니다.** `a: int`가 `{'type': 'integer'}`로, 기본값 없는 인자가 `'required': ['a', 'b']`로 변환되었습니다. 지난 글에서 손으로 썼던 `inputSchema`를 SDK가 대신 만들어 준 것입니다.

**둘째, docstring이 그대로 `Description`이 되었습니다.** 그리고 docstring을 쓰지 않은 `subtract`는 **`Description:`이 비어 있습니다.** LLM 입장에서 이 tool은 이름과 인자 타입만 있고 "무엇을 하는 함수인지"에 대한 설명이 전혀 없는 셈입니다. 앞의 팁 2번이 왜 중요한지 보여주는 장면입니다.

**셋째, 결과가 두 가지 형태로 옵니다.** `content`의 `TextContent(text='8')`는 LLM이 읽을 텍스트이고, `structuredContent={'result': 8}`은 프로그램이 파싱할 구조화된 값입니다. `isError=False`는 호출이 정상적으로 끝났다는 뜻입니다.

## 5. MCP streamable HTTP server 준비하기

여기까지 오면 MCP stdio server를 세팅하고 로컬에서 통신하는 감이 잡혔을 겁니다. 그런데 이런 궁금증이 생길 수 있습니다. 로컬이 아니라 **인터넷에서** tool을 호출하려면 MCP HTTP server를 어떻게 세팅해야 할까요?

**streamable HTTP server** 세팅을 보겠습니다. 시작은 아주 비슷합니다. `FastMCP` 클래스를 인스턴스화하고 tool을 정의합니다.

```python
# servers/streamable_http_servers/greet.py
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("StatefulServer")


@mcp.tool()
def greet(name: str = "World") -> str:
    """Greet someone by name."""
    return f"Hello, {name}!"


# Run server with streamable_http transport
if __name__ == "__main__":
    mcp.run(transport="streamable-http")
```

핵심 차이는 `run` 메서드를 호출하는 방식 **딱 한 줄**입니다. `FastMCP.run()`은 기본으로 `stdio` transport를 사용하기 때문에 앞에서는 따로 지정할 필요가 없었습니다. 하지만 **streamable HTTP**를 쓰려면 `transport="streamable-http"`를 넘기면 됩니다. tool을 정의하는 코드는 전혀 건드리지 않았다는 점에 주목하세요.

server 이름 옆의 "Stateful"은 session 상태를 유지한다는 뜻입니다. 상태가 필요 없다면 이렇게 바꿀 수 있습니다.

```python
# session을 유지하지 않는 server (수평 확장에 유리)
mcp = FastMCP("StatelessServer", stateless_http=True)

# 여기에 더해 SSE stream 없이 단발 JSON 응답만 사용
mcp = FastMCP("StatelessServer", stateless_http=True, json_response=True)
```

## 6. MCP HTTP client 준비하기

다음은 MCP client에서 HTTP server의 tool을 호출하는 부분입니다. transport가 stdio에서 HTTP로 바뀌었으니 client 설정도 조금 달라집니다.

```python
# clients/streamable_client.py
import asyncio
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


async def main():
    # Connect to a streamable HTTP server
    async with streamablehttp_client("http://localhost:8000/mcp") as (
        read_stream,
        write_stream,
        _,
    ):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()

            tools = await session.list_tools()
            for tool in tools.tools:
                print(f"Tool Name: {tool.name}\nDescription: {tool.description}\n")

            result = await session.call_tool("greet", {"name": "world!"})
            print("result: ", result)


if __name__ == "__main__":
    asyncio.run(main())
```

stdio client와 비교했을 때 주요 차이는,

1. `StdioServerParameters`를 만들 필요가 없습니다.
2. local command 대신 `streamablehttp_client`에 **server의 URL**을 지정합니다.
   - tool이 로컬 server에서 돌고 있으므로 URL은 `localhost`로 지정합니다.
   - 기본적으로 server는 8000 포트에서 실행되고 endpoint는 `/mcp`입니다.
3. `streamablehttp_client`는 stream 두 개가 아니라 **세 개**를 돌려줍니다. 세 번째는 session ID를 조회하는 콜백인데, 여기서는 쓰지 않으므로 `_`로 받았습니다.

### 실행해 보기

stdio와 달리 **이번에는 터미널이 두 개 필요합니다.** client가 server를 대신 띄워 주지 않으니, server를 먼저 켜 두어야 합니다.

```bash
# 터미널 1 — server를 먼저 실행 (계속 떠 있음)
uv run servers/streamable_http_servers/greet.py
```

```bash
# 터미널 2 — client 실행
uv run clients/streamable_client.py
```

client 쪽 출력입니다.

```text
Tool Name: greet
Description: Greet someone by name.
Input Schema: {'properties': {'name': {'default': 'World',
                                       'title': 'Name', 'type': 'string'}},
               'title': 'greetArguments', 'type': 'object'}

result:  content=[TextContent(type='text', text='Hello, world!!')]
         structuredContent={'result': 'Hello, world!!'} isError=False
```

`name`에 기본값 `"World"`가 있으므로 schema에도 `'default': 'World'`가 들어갔고, `required` 목록에는 포함되지 않았습니다.

같은 시각 server 터미널에는 이런 로그가 찍힙니다. HTTP 요청이 오갔다는 증거입니다.

```text
INFO:  127.0.0.1:48626 - "POST /mcp HTTP/1.1" 200 OK
INFO:  Processing request of type ListToolsRequest
INFO:  Processing request of type CallToolRequest
INFO:  Terminating session: 2ba1dedd291f48c9b881a3baf0e77052
INFO:  127.0.0.1:48626 - "DELETE /mcp HTTP/1.1" 200 OK
```

나머지는 stdio client와 똑같이 동작합니다. **tool을 정의하는 방식은 그대로 두면서 인터넷을 통해 MCP tool을 호출할 수 있게 되는 것**입니다.

## 두 transport 비교

| | **stdio** | **streamable HTTP** |
|---|---|---|
| server 실행 | client가 자식 프로세스로 자동 실행 | 미리 따로 띄워 둬야 함 |
| 연결 대상 | `command` + `args` | URL (`http://host:port/mcp`) |
| 터미널 개수 | 1개 | 2개 (server + client) |
| 적합한 상황 | 로컬 tool, 개발·테스트, desktop app | 원격 tool, 여러 사용자가 공유하는 server |
| 인증 | 보통 불필요 (같은 머신) | 필요 (헤더, 토큰 등) |
| server 코드 차이 | `mcp.run()` | `mcp.run(transport="streamable-http")` |

tool을 정의하는 코드는 두 경우가 완전히 동일합니다. 이게 MCP가 주는 이점입니다. **한 번 만든 tool을 transport만 바꿔 로컬에서도, 네트워크 너머에서도 쓸 수 있습니다.**

## 정리

- `FastMCP` 인스턴스를 만들고 `@mcp.tool()`을 붙이면 MCP server가 된다
- **type hint가 `inputSchema`가 되고, docstring이 `description`이 된다.** 이 둘이 LLM이 tool에 대해 아는 전부이므로 꼼꼼히 쓸 가치가 있다
- client는 `session.list_tools()` → `session.call_tool()` 순서로 tool을 발견하고 호출한다
- stdio는 client가 server를 직접 띄우고, streamable HTTP는 server를 미리 띄워 두고 URL로 연결한다. **tool 코드는 그대로다**

다음 글에서는 이미 만들어져 있는 third-party MCP server에 연결하는 방법으로 넘어가겠습니다. 하지만 이 글의 내용은 앞으로 계속 돌아오게 될 기반입니다.
