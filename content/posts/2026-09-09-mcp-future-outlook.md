---
title: "MCP 시리즈를 마치며: Resources, 그리고 CodeAct라는 다음 방향"
date: 2026-09-09
category: ai
summary: 시리즈에서 다루지 않은 resources 개념을 짚고, JSON 기반 tool calling을 대체할 수 있는 CodeAct 방식과 tool calling 연구의 흐름을 살펴보며 MCP 기초 시리즈를 마무리합니다
tags: ["MCP", "CodeAct", "LLM", "Resources", "Tool Use"]
series: MCP 기초
series_order: 6
series_repo: https://github.com/limJhyeok/mcp-tutorial
---

지난 글에서는 LLM을 MCP tool과 통합하는 방법과 그에 따르는 보안 고려사항을 배웠습니다.

이번 글로 MCP 기초 시리즈를 마무리합니다. 마지막으로 두 가지를 다룹니다.

1. 앞선 글들에서 다루지 않은 것과 그 이유
2. MCP와 관련 접근 방식의 미래 전망

## 다루지 않은 것과 그 이유

지금까지 이 시리즈에서 MCP의 여러 측면을 살펴봤습니다.

- tool의 개념과 AI 모델이 그것을 호출하는 방식을 이해하면서, MCP가 왜 만들어졌는지
- client와 server 같은 기본적인 MCP 개념
- MCP tool을 만들고, 호출하고, 기존 MCP server에 연결하는 방법
- MCP tool을 Large Language Model과 통합하는 방법

그런데 이 마지막 글에서도 여전히 다루지 못한 주제가 있습니다. 강의를 닫기 전에 중요한 개념 하나를 알려드리고 싶습니다. **resources**입니다.

**resource**는 tool과 비슷하지만 핵심적인 차이가 있습니다. **의미 있는 연산을 수행하지 않는다**는 점입니다. 구조화된 데이터 조각에 더 가깝다고 생각하면 됩니다.

```python
@mcp.resource("file://{path}")
def read_file(path: str) -> str:
    """
    Return the contents of the file at the given path (read-only).
    """
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()
```

공식 문서에 따르면 resource는 **LLM에게 데이터를 노출하는 방법**입니다. 큰 연산을 수행하지 않으면서 정보를 제공합니다. 개념적으로 tool과는 상당히 다릅니다.

| | **Tool** | **Resource** |
|---|---|---|
| 하는 일 | 동작을 수행한다 (계산, 쓰기, 검색) | 데이터를 읽어서 준다 |
| 부작용 | 있을 수 있다 | 없다 (읽기 전용) |
| 누가 호출을 결정하나 | 보통 **모델**이 판단해서 부른다 | 보통 **애플리케이션**이 골라서 context에 넣는다 |
| 비유 | POST 요청 | GET 요청 |
| 등록 방법 | `@mcp.tool()` | `@mcp.resource("file://{path}")` |

3편에서 다룬 filesystem server를 떠올려 보면 감이 잡힙니다. "이 파일을 읽어라"는 tool로도, resource로도 표현할 수 있습니다. 차이는 **누가 그 결정을 내리느냐**입니다. tool이면 모델이 스스로 부를지 판단하고, resource면 애플리케이션이 미리 골라 context에 넣어 줍니다. 사용자가 첨부한 파일처럼 "이건 확실히 필요한 데이터"인 경우에는 후자가 더 예측 가능합니다.

그러면 왜 전부 다루지 않았을까요?

1. **핵심에 집중하기 위해서입니다.** 입문자에게는 가장 중요한 개념부터 시작하는 게 쉽습니다. 한 번에 너무 많은 것을 다루면 숲에서 길을 잃는 것처럼 압도될 수 있습니다.
2. **이제 스스로 더 탐색할 준비가 되었기 때문입니다.** 여기까지 왔다면 MCP의 핵심 개념 대부분을 이해한 상태입니다. 이 기반이 있으면 공식 문서를 읽거나 고급 주제를 직접 탐색하기가 훨씬 쉽습니다.

## 미래 전망

전통적인 MCP tool calling이 어떻게 동작하는지 다시 정리해 보겠습니다.

1. LLM이 tool 이름과 인자를 담은 JSON 형식의 출력을 생성한다.
2. MCP client가 이 JSON을 JSON-RPC protocol로 MCP server에 보낸다.
3. server가 tool을 실행하고 결과를 client에 돌려준다.
4. MCP client가 이 결과를 LLM의 context에 삽입한다.
5. LLM이 갱신된 context를 바탕으로 출력 생성을 이어 간다.

이 방식은 잘 동작하지만, tool을 호출하는 유일한 방법은 아닙니다.

### CodeAct

더 새로운 접근으로 **CodeAct**가 있습니다. LLM이 **실행 가능한 코드를 직접 생성하는 능력**을 활용하는 방식입니다.

아이디어는 이렇습니다. 사람이 정의한 tool에 의존하는 대신, LLM이 과제를 해결하기 위한 Python 코드를 생성합니다.

**예시**

`User:`

> ./data.csv에 있는 CSV 파일을 분석해 주세요.

`CodeAct Agent:`

> 이 작업을 위해 pandas library를 사용하겠습니다....

```python
import pandas as pd
import numpy as np

# Load dataset
df = pd.read_csv(...)

# Check for missing values
print(df.isnull().sum())

# Further processing...
```

위에서 생성된 코드는 python interpreter가 실행하고, 그 결과가 LLM의 context로 되돌아갑니다. 그러면 LLM은 과제를 완료하기 위한 다음 단계를 생성합니다.

흥미롭게도 CodeAct 저자들은 이 접근이 전통적인 JSON 기반 tool calling을 **능가할 수 있다**고 이야기합니다. **LangGraph**와 Hugging Face의 **agent library** 같은 framework들이 CodeAct 스타일 agent를 지원하기 시작했습니다.

중요한 지점 하나. MCP는 tool call을 표준화하기 위해 JSON-RPC를 중심으로 만들어졌지만, CodeAct는 tool call에 JSON 형식이 필요하지 않기 때문에 다른 protocol을 요구할 수 있습니다. JSON 대신 **python interpreter**가 필요합니다.

사실 tool calling은 여전히 활발한 연구 분야입니다. LLM으로 tool을 효과적으로 사용하는 방법을 우리는 막 탐색하기 시작했을 뿐이고, 앞으로의 방법과 표준은 지금 우리가 쓰는 것과 꽤 다른 모습일 수 있습니다.

**For more information**

- [CodeAct 논문 — Executable Code Actions Elicit Better LLM Agents (arXiv:2402.01030)](https://arxiv.org/abs/2402.01030)
- [Hugging Face Agents Course — Code Agents](https://huggingface.co/learn/agents-course/unit2/smolagents/code_agents)

## 정리

- 시작하는 데 필요한 MCP 핵심 개념을 모두 다뤘습니다.
- 앞으로 LLM은 CodeAct에서 보이듯 코드 실행 작업을 직접 처리하는 방향으로 발전하고 있고, 이는 미래의 MCP 유사 framework에도 영향을 줄 수 있습니다.

MCP 기초 시리즈는 여기까지입니다. 끝까지 따라와 주셔서 감사합니다. 이제 고급 MCP 주제와 차세대 LLM tool들을 탐색할 준비가 되었길 바랍니다.
