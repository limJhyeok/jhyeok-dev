---
title: "이미 있는 MCP Server에 연결하기: Filesystem, Git, Tavily"
date: 2026-09-09
category: ai
summary: 처음부터 다 만들지 않고 third-party MCP server를 쓰는 방법. 공식 repository의 Filesystem·Git server와 API key가 필요한 Tavily search server를 npx·uvx로 연결합니다
tags: ["MCP", "Filesystem", "Git", "Tavily", "Python"]
series: MCP 기초
series_order: 4
series_repo: https://github.com/limJhyeok/mcp-tutorial
---

이번 글에서는 **이미 존재하는 MCP server**에 연결하는 방법을 다룹니다.

앞에서처럼 모든 것을 처음부터 만드는 대신, 이미 나와 있는 **third-party MCP server**를 쓸 수 있습니다. 시간을 아끼고 boilerplate가 아닌 실제 use case에 집중할 수 있게 해줍니다.

## 핵심: client 코드는 바뀌지 않는다

본론에 들어가기 전에 이 글 전체를 관통하는 사실을 먼저 말해 두겠습니다. **지난 글에서 쓴 client 코드를 거의 그대로 재사용합니다.** 우리가 만든 calculator server든, 남이 만든 filesystem server든, MCP client 입장에서는 똑같이 생긴 stdio server일 뿐이기 때문입니다.

지난 글의 client는 이런 모양이었습니다.

```python
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
import asyncio

# ▼▼▼ 이 부분만 server마다 바뀝니다 ▼▼▼
server_params = StdioServerParameters(
    command="uv",
    args=["run", "servers/stdio_servers/calculator.py"],
)
# ▲▲▲ 아래는 전부 동일 ▲▲▲


async def run():
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await session.list_tools()
            for tool in tools.tools:
                print(f"Tool Name: {tool.name}\nDescription: {tool.description}\n")


if __name__ == "__main__":
    asyncio.run(run())
```

앞으로 나올 세 개의 server는 **`server_params` 정의만 갈아 끼우면** 위 코드로 전부 동작합니다. 그래서 이 글에서는 매번 전체 파일을 반복하지 않고 바뀌는 부분만 보여드리겠습니다.

## 준비물: npx와 uvx

third-party MCP server는 대부분 npm 패키지 아니면 Python 패키지로 배포됩니다. 그래서 둘을 실행할 도구가 필요합니다.

| 도구 | 실행 대상 | 설치 방법 |
|---|---|---|
| **`npx`** | npm(Node.js) 패키지 | [Node.js](https://nodejs.org) 설치 시 함께 설치됨 |
| **`uvx`** | Python 패키지 | [uv](https://docs.astral.sh/uv/getting-started/installation/) 설치 시 함께 설치됨 |

두 도구의 공통점이 중요합니다. **전역 설치 없이 패키지를 그때그때 내려받아 실행합니다.** 즉 MCP server를 쓰려고 `npm install -g`를 할 필요가 없습니다. 처음 실행할 때만 다운로드가 일어나고 이후에는 캐시에서 바로 뜹니다.

```bash
# 설치 확인
node -v && npx -v
uv --version && uvx --version
```

## MCP 공식 repository

먼저 알아둘 것은, MCP 커뮤니티가 이미 **공식 server repository**를 운영하고 있다는 점입니다. filesystem, Git, Google Drive 등을 다루는 server들을 찾을 수 있습니다. 그중 흔히 쓰이는 몇 개를 보겠습니다.

- [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) — 공식 reference server 모음

## 1. Filesystem MCP Server

MCP client가 내 머신의 파일과 상호작용하게 하고 싶다고 해 봅시다. **filesystem MCP server**를 쓸 수 있습니다.

```python
import os

workspace_folder = os.getcwd()

server_params = StdioServerParameters(
    command="npx",
    args=["-y", "@modelcontextprotocol/server-filesystem", workspace_folder],
)
```

여기서 무슨 일이 벌어지는 걸까요?

- **`npx`** 는 Node.js 도구입니다. npm 패키지를 전역 설치 없이 바로 실행할 수 있게 해줍니다.
- **`-y`** 는 "설치할까요?" 프롬프트를 건너뛰라는 뜻입니다. client가 자동으로 띄우는 프로세스라 사람이 답할 수 없으므로 필요합니다.
- **`@modelcontextprotocol/server-filesystem`** 이 MCP server를 노출하는 npm 패키지입니다.
- 마지막으로 **workspace folder**를 넘겨서, 어디에서 동작해야 하는지 알려줍니다.

마지막 인자가 특히 중요합니다. 이건 단순한 "작업 디렉터리" 설정이 아니라 **접근 허용 범위(allowed directory)** 입니다. 이 server는 여기에 지정한 디렉터리 **바깥의 파일은 아예 읽지도 쓰지도 못합니다.** 실수로 홈 디렉터리 전체나 `/`를 넘기지 않도록 주의하세요. 여러 디렉터리를 허용하고 싶다면 인자를 이어서 넘기면 됩니다.

실행하면 이런 tool들이 나옵니다.

```text
read_text_file          write_file        list_directory
read_media_file         edit_file         list_directory_with_sizes
read_multiple_files     create_directory  directory_tree
get_file_info           move_file         search_files
list_allowed_directories
```

파일 하나를 실제로 읽어 보려면 이렇게 호출합니다.

```python
result = await session.call_tool(
    "read_text_file",
    {"path": os.path.join(workspace_folder, "README.md")},
)
print(result.content[0].text)
```

`list_allowed_directories`를 호출해 보면 방금 이야기한 접근 범위를 직접 확인할 수 있습니다. 새 server에 연결했을 때 가장 먼저 눌러 볼 만한 tool입니다.

## 2. Git MCP Server

다음으로 Git repository와 상호작용하고 싶다고 해 봅시다. 바로 쓸 수 있는 **Git MCP server**가 있습니다.

```python
import os

server_params = StdioServerParameters(
    command="uvx",
    args=[
        "mcp-server-git",
        "--repository",
        os.getcwd(),
    ],
)
```

이번에는 **`uvx`** 를 사용합니다. npx와 비슷하지만 Python 기반 MCP server를 위한 도구입니다. 로컬에 설치되어 있지 않아도 Python 패키지를 바로 실행할 수 있게 해줍니다. 여기서 `mcp-server-git`은 Git에 대한 MCP 인터페이스를 제공하는 Python 패키지입니다. `--repository` 플래그에 현재 디렉터리를 넘겨서 어느 repo를 다룰지 알려줍니다.

노출되는 tool 목록입니다.

```text
git_status       git_add       git_log            git_show
git_diff         git_reset     git_create_branch  git_branch
git_diff_staged  git_commit    git_checkout
git_diff_unstaged
```

읽기 전용 조회부터 `git_commit`, `git_checkout` 같은 **저장소를 실제로 바꾸는 tool까지 함께 들어 있다**는 점을 눈여겨보세요. 다음 글에서 이 tool들을 LLM에게 쥐어 줄 텐데, 그때 LLM은 `git_status`를 부를 수도 있고 `git_reset`을 부를 수도 있습니다.

`git_status`를 호출해 보겠습니다.

```python
result = await session.call_tool("git_status", {"repo_path": os.getcwd()})
print(result.content[0].text)
```

```text
Repository status:
On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean
```

터미널에서 `git status`를 친 것과 같은 결과가, 이번에는 **LLM이 읽을 수 있는 구조화된 응답으로** 돌아왔습니다. 개발자 중심 workflow를 만들 때 아주 유용합니다.

## 3. Tavily MCP Server

그럼 MCP client에 **검색 기능**을 바로 붙이고 싶다면 어떻게 할까요?

여기서 **Tavily MCP server**가 등장합니다. Tavily는 개발자와 LLM을 위해 설계된 search API이고, MCP server를 통해 웹을 매끄럽게 질의할 수 있습니다.

```python
import os
from dotenv import load_dotenv

load_dotenv()
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")

server_params = StdioServerParameters(
    command="npx",
    args=["-y", "tavily-mcp@latest"],
    env={"TAVILY_API_KEY": TAVILY_API_KEY},
)
```

눈치챘을 수도 있는데, **Filesystem**이나 **Git** MCP server와 달리 **Tavily MCP server는 API key가 필요합니다.** 외부 서비스인 Tavily의 search API에 연결하고, 그 서비스가 인증을 요구하기 때문입니다.

그래서 첫 단계는 [Tavily 웹사이트](https://app.tavily.com/)에서 API key를 발급받는 것입니다. 발급받은 key는 프로젝트 루트의 `.env` 파일에 둡니다.

```bash
# .env  (반드시 .gitignore에 추가할 것)
TAVILY_API_KEY=tvly-xxxxxxxxxxxxxxxx
```

여기서 `StdioServerParameters`의 **`env` 파라미터**가 새로 등장했습니다. stdio server는 client가 띄우는 자식 프로세스이므로, 그 프로세스에 전달할 환경 변수를 client가 지정해 주어야 합니다. 우리 셸에 `TAVILY_API_KEY`가 있다고 해서 자식 프로세스가 자동으로 물려받지는 않습니다.

검색을 실행해 보겠습니다.

```python
result = await session.call_tool(
    "tavily-search",
    {"query": "latest AI research papers 2025"},
)
print(result.content[0].text)
```

> **key는 항상 안전하게 보관해야 합니다.** environment variable을 사용하고, 스크립트에 하드코딩하지 마세요. 그리고 key를 repository나 다른 공개 서비스에 절대 업로드하지 마세요. `.env`는 커밋 대상에서 제외하고, 예시 값만 담은 `.env.example`을 대신 커밋하는 것이 일반적인 방식입니다.

## 세 server 비교

| | Filesystem | Git | Tavily |
|---|---|---|---|
| 실행 도구 | `npx` | `uvx` | `npx` |
| 패키지 | `@modelcontextprotocol/server-filesystem` | `mcp-server-git` | `tavily-mcp@latest` |
| 필수 인자 | 허용 디렉터리 경로 | `--repository <경로>` | 없음 |
| API key | 불필요 | 불필요 | **필요** (`env`로 전달) |
| 접근 대상 | 로컬 파일 | 로컬 Git repo | 외부 웹 |

패턴이 보입니다. **MCP server를 붙인다는 건 결국 "무슨 명령으로 띄울지"와 "무엇을 넘길지"를 정하는 일**입니다. 그 뒤의 client 코드는 어떤 server든 동일합니다. 다음 글에서는 이 설정들을 JSON 파일 하나로 모아 여러 server를 한 번에 관리하게 됩니다.

## 정리

- third-party MCP server는 `server_params`만 바꾸면 지난 글의 client로 그대로 쓸 수 있다
- `npx`는 npm 패키지를, `uvx`는 Python 패키지를 **전역 설치 없이** 실행한다
- **Filesystem** — 허용 디렉터리를 인자로 넘긴다. 그 바깥은 접근 불가
- **Git** — `--repository`로 대상 repo를 지정한다. 조회뿐 아니라 변경 tool도 포함되어 있다
- **Tavily** — API key가 필요하고, `StdioServerParameters(env=...)`로 자식 프로세스에 전달한다

다음 글에서는 이 MCP tool들을 LLM과 통합하는 방법을 알아보겠습니다.
