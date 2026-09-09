---
title: "AI는 어떻게 도구를 쓰는가: Toolformer에서 MCP까지"
date: 2026-09-09
category: ai
summary: LLM에게 tool이 왜 필요한지부터 Toolformer 방식의 tool use 학습 원리, 그리고 그 한계인 M×N 문제를 거쳐 MCP(Model Context Protocol)라는 표준이 등장한 배경까지 정리합니다
tags: ["MCP", "Tool Use", "Toolformer", "LLM", "Function Calling"]
series: MCP 기초
series_order: 1
series_repo: https://github.com/limJhyeok/mcp-tutorial
---

> MCP로 애플리케이션을 만들고 싶은 개발자를 대상으로 합니다. LLM의 기본 구조(context window, hallucination 같은 한계)와 client–server 모델, API에 대한 감각이 있으면 읽기 편합니다.

## 1. Tool이란 무엇인가

AI 관점에서 **tool**은 모델이 텍스트 생성 능력을 넘어서기 위해 호출할 수 있는 외부 함수, 서비스, 리소스를 말합니다.

- 정확한 계산을 위한 calculator 함수
- 실시간 날씨를 가져오는 weather API
- 구조화된 데이터를 조회하는 database connector

### 왜 tool이 필요한가

ChatGPT 같은 AI는 아주 똑똑한 사람과 비슷하지만, 한 가지 큰 제약이 있습니다. **텍스트를 읽고 쓰는 일만 할 수 있다**는 것입니다. 강력하지만 동시에 분명한 한계이기도 합니다.

**첫째, AI는 지금 무슨 일이 벌어지고 있는지 모릅니다.** 학습이 끝나는 시점까지의 정보만 알고 있습니다. 2024년까지의 데이터로 학습했다면 2025년에 무슨 일이 있었는지는 전혀 알지 못합니다. 아주 지혜롭지만 디지털 섬에 갇혀 오늘의 뉴스도, 오늘의 날씨도 알 수 없는 사람과 같습니다.

**둘째, tool은 사람에게 그렇듯 AI도 똑똑하게 만듭니다.** 계산기 없이 수학 숙제를 하는 상황을 떠올려 보면 됩니다. 풀 수는 있지만 느리고, 실수가 늘고, 금방 지칩니다. AI도 마찬가지입니다. 사고는 할 수 있어도 계산 같은 작업에서는 완벽하지 않습니다. 적절한 tool이 주어지면 훨씬 강력해집니다.

**셋째, AI는 혼자서 모든 것을 할 수 없습니다.** language model은 본질적으로 "text-in, text-out" 기계입니다. 이미지를 직접 분석하거나, 소리를 듣거나, 현실 세계를 확인할 수 없습니다. 하지만 image recognizer나 sound recognizer 같은 tool을 쥐어 주면 그 한계를 단숨에 넘어섭니다.

### 직접 확인해 보기

설명만으로는 부족하니 실제로 확인해 봅시다. 아주 큰 곱셈 하나를 물어보겠습니다.

> **123,423,215 × 1,232,323,424는 얼마인가?**

간단한 곱셈처럼 보이지만, tool 없이 이 크기의 숫자를 다루는 건 누구에게도 쉽지 않습니다. 저 역시 계산기나 최소한 종이와 펜이 필요합니다. "똑똑한 AI"가 tool 없이 이걸 해낼 수 있는지 보겠습니다. ChatGPT에 이렇게 넣어 봅니다.

```text
<Instruction> You should not call the tools like calculator. You should not think long. </Instruction>

<Question> What is 123,423,215 × 1,232,323,424? </Question>

<Output> answer: int </Output>
```

GPT가 결과를 내놓습니다. 그리고 솔직히 **그럴듯해 보입니다**. 18자리 숫자가 나오고, 맨 앞자리도 얼추 맞습니다.

하지만 실제 값은 이렇습니다.

```text
123,423,215 × 1,232,323,424 = 152,097,318,909,888,160
```

계산기를 열어 맞춰 보면 대개 **자릿수와 앞머리는 맞는데 가운데 숫자들이 어긋나 있습니다.** 모델이 곱셈을 *계산한* 게 아니라 "이쯤 되는 숫자가 나올 것 같다"고 *생성했기* 때문입니다. 그럴듯해 보인다는 점이 오히려 문제입니다. 틀린 티가 나지 않으니까요.

AI는 똑똑하지만, 사람과 마찬가지로 자신의 능력을 온전히 발휘하려면 알맞은 tool이 필요합니다. 그래서 tool이 중요합니다.

## 2. 고전적인 tool use — Toolformer (2023)

AI에게 왜 tool이 필요한지는 알았습니다. 다음 질문은 이것입니다. **AI는 실제로 어떻게 tool을 사용하는가?** 그리고 똑같이 중요한 질문, **언제 tool을 써야 하는지는 어떻게 아는가?**

LLM은 text-in, text-out 기계일 뿐입니다. 그 자체로는 계산기를 두드리거나 코드를 실행하거나 외부 함수를 호출할 능력이 없습니다. 여기서 **Toolformer**가 등장합니다. 아이디어는 놀랄 만큼 단순합니다.

1. **모델이 언제, 어떻게 함수를 호출해야 하는지를 학습시킵니다.** 그러면 모델은 답을 바로 말하는 대신 이런 텍스트를 생성합니다.
   ```text
   [→ API_CALL: calculator(25 * 12)]
   ```
2. **AI가 이 특수한 "API call" 텍스트를 만들어 내는 순간, 응답 생성을 잠시 멈춥니다.**
3. **시스템이 실제로 함수를 실행합니다.** 예를 들어 그 숫자들로 calculator를 호출합니다.
4. **함수 호출 결과를 대화에 다시 끼워 넣습니다.**
5. **AI가 올바른 결과를 가지고 응답을 이어 갑니다.**

이렇게 AI는 더 이상 텍스트에만 갇혀 있지 않게 됩니다. 사람이 계산기와 검색 엔진을 쓰듯, 외부 tool로 정확한 답을 얻을 수 있습니다.

### 예제로 보기

언제·어떻게 함수를 호출할지 모델에게 가르치기 위해, 먼저 prompt를 줍니다. LLM은 문맥을 이해하고 알맞은 형식의 출력을 스스로 만들어 냅니다.

```python
# source: https://github.com/lucidrains/toolformer-pytorch/blob/main/toolformer_pytorch/prompts.py

system_prompt = """
Your task is to add calls to a Calculator API to a piece of text.
The calls should help you get information required to complete the text.
You can call the API by writing "[Calculator(expression)]" where "expression" is the expression to be computed.
Here are some examples of API calls:
Input: The number in the next term is 18 + 12 x 3 = 54.
Output: The number in the next term is 18 + 12 x 3 = [Calculator(18 + 12 * 3)] 54.

...(more examples)...

Input: What is 123,423,215 × 1,232,323,424?
Output:
"""
```

이 prompt로 테스트하면 LLM은 대략 이런 출력을 냅니다.

```text
What is 123,423,215 × 1,232,323,424 = [Calculator(123423215 * 1232323424)]?
```

연구자들은 이 input-output 쌍으로 LLM을 학습시킵니다.

```text
Input:  What is 123,423,215 × 1,232,323,424?
Output: What is 123,423,215 × 1,232,323,424 = [Calculator(123423215 * 1232323424)]?
```

이 과정을 통해 LLM은 tool을 **언제** 그리고 **어떻게** 호출하는지에 대한 일반적인 패턴을 익힙니다. 학습이 끝나면 올바른 인자를 담은 API/함수 호출을 생성할 수 있고, 우리는 그것을 실행해서 결과를 prompt에 되돌려 넣으면 됩니다.

```text
Input:  What is 123,423,215 × 1,232,323,424?
Output: What is 123,423,215 × 1,232,323,424 = [Calculator(123423215 * 1232323424) -> 152097318909888160]?
```

이제 LLM은 API의 결과를 알고 있으니 정확하게 답할 수 있습니다. 앞의 큰 곱셈을 이 API 결과와 함께 다시 물어보면 이렇게 됩니다.

```text
<Instruction>
You should not call the tools like calculator.
You should not think long.
</Instruction>

<Question>
What is 123,423,215 × 1,232,323,424 = [Calculator(123423215 * 1232323424) -> 152097318909888160]?
</Question>

<Output> answer: int </Output>
```

이번엔 GPT가 정답을 내놓습니다. 이렇게 tool에 대한 접근을 주는 것만으로 **LLM의 능력을 확장**하고 더 정확하게 문제를 풀게 만들 수 있습니다.

### 짚고 넘어갈 점: 학습에서 본 적 없는 API도 호출한다

다음 절로 넘어가기 전에 강조하고 싶은 지점이 있습니다. LLM은 **학습 시점에 한 번도 본 적 없는 API에 대해서도** 언제·어떻게 호출할지를 생성할 수 있습니다. 위와 같은 방식으로 학습하면 LLM이 API 호출 메커니즘의 **패턴 자체를 일반화**하기 때문입니다.

추론 시점에 LLM은 이렇게 동작합니다.

1. 이 질문에는 외부 tool이 필요하다는 것을 인식한다.
2. **학습한 패턴을 따라** 올바른 형식의 함수/API 호출을 생성한다.
3. tool의 결과를 사용해 최종 답변을 만든다.

그래서 아래처럼 prompt를 주면,

```text
<System>
You have the ability to call the tool.
I will give you the tool description:
{
  "tool_name": "get_current_time",
  "Description": "Get the current time in a specific timezone.",
  "Arguments": "timezone (required): IANA timezone name (e.g., America/New_York, Europe/London). If not provided, defaults to America/New_York."
}
</System>
```

LLM은 문맥을 이해하고 질문에 맞춰 언제·어떻게 호출할지를 생성합니다. "지금 런던 몇 시야?"라고 물으면 이런 출력이 나옵니다.

```text
get_current_time(timezone="Europe/London")
```

`get_current_time`이라는 tool은 학습 데이터에 없었습니다. 모델이 아는 것은 방금 prompt로 받은 description 한 조각뿐입니다. 그런데도 **인자 이름과 IANA timezone 형식까지 맞춰서** 호출을 만들어 냅니다. 이 일반화 능력이 오늘날의 tool use — 그리고 MCP — 를 가능하게 하는 토대입니다.

**Reference:** [ChatGPT 대화 기록](https://chatgpt.com/share/68b136fc-fbf8-8010-bbdc-b223e442e7f5)

### tool은 앞의 문제들을 어떻게 해결하는가

앞서 이야기한 세 가지 한계는 이렇게 풀립니다.

**AI가 지금 벌어지는 일을 알 수 있다** — 적절한 시점에 tool을 호출해서

```text
How's the weather today?[Weather() -> Rainy]
```

**tool이 AI를 더 똑똑하게 만든다**

```text
(...아주 어려운 수학 문제를 푼 뒤...),
the result is this: 37/20[calculator(37/20) -> 1.85]
```

**AI가 혼자 못 하는 일을 할 수 있다**

```text
Summarise this meeting recording[sound_extractor(file) -> "Today, we have to discuss about ..."]
```

## 3. 그런데 문제는 남아 있다 — Toolformer 방식의 한계

### 같은 tool을 계속해서 다시 만든다

첫 번째 문제입니다. 모델에게 tool을 쥐어 주고 싶을 때마다 **매번 처음부터 만들어야 합니다.**

회사에서 LLM에 **calculator, search engine, translator**를 붙이기로 했다고 해 봅시다. 좋습니다, 만들었습니다. 그런데 제가 개인 프로젝트를 시작하면서 제 LLM에 **calculator, image recognizer, translator**를 붙이고 싶어집니다. calculator와 translator를 처음부터 다시 만들어야 합니다.

저만 그런 게 아닙니다. 모든 개발자가 조금씩 다른 프로젝트를 위해 같은 tool을 반복해서 만듭니다. library로 공유하면 되지 않느냐고 할 수 있지만, 여기에 함정이 있습니다. 다들 자기만의 형식과 스타일로 만들기 때문에 **일관된 방식으로 재사용되지 않습니다.**

### 모델마다 형식이 다르다

두 번째 문제는 AI 플랫폼마다 tool을 등록하고 호출하는 방식이 제각각이라는 점입니다. OpenAI는 함수를 등록하고 API를 호출하는 자체 방식을 정의합니다. 다른 플랫폼은 다르게 합니다. 결국 **같은 tool이라도 붙이려는 모델에 맞춰 다시 쓰거나 형식을 바꿔야 합니다.**

```python
# 1. Define a list of callable tools for the model
tools = [
    {
        "type": "function",
        "name": "get_horoscope",
        "description": "Get today's horoscope for an astrological sign.",
        "parameters": {
            # ... (JSON schema)
        },
    }
]

# 2. Prompt the model with tools defined
response = client.responses.create(
    model="gpt-5",
    tools=tools,
    input=input_list,
)

# Save function call outputs for subsequent requests
input_list += response.output

for item in response.output:
    if item.type == "function_call":
        if item.name == "get_horoscope":
            # 3. Execute the function logic for get_horoscope
            horoscope = get_horoscope(json.loads(item.arguments))

            # 4. Provide function call results to the model
            input_list.append({
                "type": "function_call_output",
                "call_id": item.call_id,
                "output": json.dumps({
                  "horoscope": horoscope
                })
            })

            ...
```

![Model 1·2·3 세 개의 모델과 Database·Filesystem·Calculator 세 개의 tool이 각각 서로 다른 색의 선으로 전부 연결되어 아홉 개의 연결선이 얽혀 있는 다이어그램. 모델과 tool을 개별적으로 연결할 때 발생하는 M×N 문제를 나타낸다](/images/from-toolformer-to-mcp/mxn-problem.png)

이것이 바로 **M × N 문제**입니다. 모델도 많고 tool도 많은데, 이들을 이어 줄 표준이 없습니다.

**References**

1. [OpenAI — Function calling](https://platform.openai.com/docs/guides/function-calling#function-tool-example)
2. [Anthropic — Tool use overview](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)

## 4. MCP로의 전환

그러면 이 문제를 어떻게 풀어야 할까요?

우리에게 정말 필요한 건 **표준**입니다. AI 모델과 tool을 잇는 보편적인 방법 말입니다. 모든 개발자가 각 모델과 각 tool 사이의 연결을 직접 만들게 하는 대신, 통신을 대신 처리해 주는 **중간 계층(intermediate layer)** 을 만들면 됩니다.

새로운 발상은 아닙니다. 다른 분야에서 이미 같은 일이 벌어졌습니다. operating system, compiler, 그리고 USB-C port가 그렇습니다.

![왼쪽의 Model 2가 점선 화살표(Unified APIs)를 통해 가운데의 MCP 계층에 하나의 선으로 연결되고, MCP 계층이 오른쪽의 Database·Filesystem·Calculator 세 tool에 각각 연결되는 다이어그램. 중간 계층 하나로 연결 수가 줄어드는 구조를 나타낸다](/images/from-toolformer-to-mcp/mcp-unified-layer.png)

AI 세계에서 이에 해당하는 해법이 **Model Context Protocol**, 줄여서 **MCP**입니다. MCP를 만든 사람들이 이것을 **AI의 USB-C port**라고 부르는 이유가 여기에 있습니다. 끝없는 재작성 없이 모델과 tool이 매끄럽게 연결되도록 하는 공통 표준이기 때문입니다.

**Image reference:** [Hugging Face — MCP Course, Key Concepts](https://huggingface.co/learn/mcp-course/unit1/key-concepts)

## 정리

- **Tool**: AI 모델이 텍스트 생성을 넘어선 능력을 얻기 위해 호출할 수 있는 외부 함수·서비스·리소스
- **tool이 필요한 이유**
  - LLM은 실시간 정보에 접근할 수 없다
  - tool은 사람에게 그렇듯 AI도 더 똑똑하게 만든다
  - AI는 혼자서 모든 것을 할 수 없다
- **Toolformer (2023)**
  - LLM에게 tool을 **언제**, **어떻게** 호출할지 학습시킨다
  - 앞서 말한 세 가지 문제를 해결할 수 있다
  - 한계: 플랫폼마다 tool 형식이 달라 → **M × N 문제**
- **MCP (Model Context Protocol)**
  - tool use를 위한 **표준**
  - USB-C처럼, AI와 tool을 잇는 하나의 보편적 커넥터
