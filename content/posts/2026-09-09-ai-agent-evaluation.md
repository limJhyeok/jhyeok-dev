---
title: "AI Agent는 어떻게 평가할까"
date: 2026-09-09
category: ai
summary: AI Agent 평가의 목적부터 데이터셋 기반 비교, LLM-as-a-Judge, simulation 기반 task 평가, tool 사용·trajectory·graph 단위의 세부 평가 방안과 평가 framework까지 정리합니다
tags: ["AI Agent", "LLM", "Evaluation", "LLM-as-a-Judge", "Benchmark"]
---

> 이 글은 **AI Agent 평가의 개념과 방법 지도(map)** 를 정리한 글입니다.
> RAG 시스템에 초점을 맞춘 평가 개념은 <a href="#" onclick="showPostDetail('2026-09-09-rag-evaluation-concepts.md');return false;">RAG 평가, 무엇을 어떻게 측정할 것인가</a> 글에서 다룹니다.

AI Agent는 단순히 질문에 답하는 모델이 아닙니다. **스스로 계획을 세우고, tool을 호출하고, 여러 단계를 거쳐 목표 상태에 도달하는 시스템**입니다. 그래서 "정답을 맞혔는가"만 확인하는 평가로는 Agent의 품질을 제대로 알 수 없습니다. 답은 맞았지만 엉뚱한 tool을 다섯 번 호출했을 수도 있고, 우연히 정답 노드에 도달했을 수도 있습니다.

이 글에서는 Agent 평가의 **목적(왜)**, **큰 접근 방식(무엇을 기준으로)**, **세부 평가 방안(어느 단위로)** 을 순서대로 정리합니다.

## 1. 평가의 이유와 목적

Evaluation은 단순히 모델의 성능을 측정하는 절차를 넘어, AI 시스템의 **품질 관리, 안정적 운영, 비용 효율화, 리스크 관리**를 위한 핵심 과정입니다.

### 성능 (Performance)

AI 시스템은 다양한 구성요소(모델, 데이터, 인프라, 파이프라인 등)의 상호작용으로 동작합니다. 평가는 이 전체 시스템이 실제 **비즈니스 혹은 운영 목표를 얼마나 잘 달성하는지**를 확인하기 위한 과정입니다.

- **정량적 지표**: Accuracy, F1, Precision/Recall, Latency, Uptime 등 객관적 수치 기반 평가
- **정성적 지표**: 사용자 만족도, 응답 품질, 이해도, 신뢰도 등 사람 중심의 평가 항목
- **목표 연계**: 모든 지표는 조직의 KPI 및 서비스 목표와 연동되어야 하며, 단순 성능 수치가 아닌 "업무/서비스 성과 기여도"로 평가되어야 합니다
- **지속적 성능 모니터링**: 시스템 업데이트, 모델 교체, 데이터 변화에 따라 평가 기준을 정기적으로 갱신해야 합니다

### 비용 (Cost)

AI 시스템은 높은 연산 자원과 스토리지를 요구하므로, 평가를 통해 **비용 효율성**을 지속적으로 관리해야 합니다.

- **운영 비용 분석**: 모델 추론 비용(inference cost), 인프라 사용량, 데이터 저장비 등을 주기적으로 모니터링
- **비용–효과 균형**: 동일한 성능을 유지하면서 더 효율적인 모델·하드웨어·파이프라인 구성으로 최적화할 수 있는지 평가
- **리소스 최적화**: 오버스펙된 모델이나 비효율적인 데이터 파이프라인을 식별하여 개선
- **ROI 관점 평가**: 단순 비용 절감이 아닌, 시스템 투자 대비 성과(Return on Investment)까지 측정

Agent는 특히 **한 번의 요청이 여러 번의 LLM 호출과 tool 호출로 확장**되기 때문에, 단일 응답 모델보다 비용 변동성이 훨씬 큽니다. "정답률이 3% 올랐지만 호출 수가 두 배가 되었다"면 그 변경이 정말 개선인지 따져 봐야 합니다.

### 검증 (Validation)

AI 시스템은 **신뢰성과 재현성, 그리고 윤리적 책임**을 보장해야 합니다. 평가 체계는 이러한 요소들을 검증하기 위한 필수 절차입니다.

- **재현성 확보**: 모델 버전, 데이터셋, 파라미터, 환경 설정 등 모든 구성요소를 추적·관리하여 동일 결과 재현 가능성을 보장
- **품질 기준 통과**: 모델 및 시스템은 배포 전 정의된 품질 게이트(Quality Gate) 또는 승인 절차를 통과해야 함
- **윤리·보안 검증**: 데이터 편향, 개인정보 노출, 공격 취약점, 비윤리적 의사결정 등 리스크 요인을 평가
- **감사 가능성(Auditability)**: 시스템의 결정 과정과 결과가 사후 감사 및 설명 가능(Explainable)해야 함

### 디버깅 및 운영 안정화 (Debugging)

AI 시스템은 데이터 품질 저하, 모델 드리프트, 외부 환경 변화 등으로 인해 예기치 못한 오류를 발생시킬 수 있습니다. 평가는 이러한 문제를 **조기에 탐지하고 신속히 복구할 수 있는 체계적 관리 도구**로서의 역할을 수행합니다.

- **이상 탐지 및 알림**: 성능 저하, 응답 오류, 데이터 이상 패턴 등을 실시간으로 감지하고 경고
- **문제 추적**: 로그, 메트릭, 버전 정보 등을 기반으로 문제 원인을 빠르게 식별
- **롤백 메커니즘**: 오류 발생 시 안정된 이전 버전으로 즉시 복귀할 수 있는 체계를 확보
- **지속적 개선**: 디버깅 과정에서 확보한 데이터를 학습 및 재평가에 반영하여 시스템의 자기진화(Self-Improvement)를 촉진

## 2. 평가 방안 — 세 가지 접근

Agent 평가는 크게 세 가지 방식으로 접근할 수 있습니다. **① 정답 label과 비교하기**, **② LLM에게 채점을 맡기기**, **③ 환경을 시뮬레이션해 task 달성 여부를 보기**입니다.

### 2-1. 데이터셋 구축 후 label 데이터와 비교

가장 고전적인 방식으로, 평가용 데이터셋을 만들고 Agent의 출력을 정답 label과 비교합니다. label을 만드는 방법은 두 가지입니다.

| 방식 | 장점 | 단점 |
| --- | --- | --- |
| **Human labelling** | gold standard, 신뢰도 높음 | 비용이 크고 느림 |
| **AI-generated labelling (LLM judge)** | 빠르고 확장 가능 | noise가 많음 |

**Human labelling**

사람 annotator가 각 레코드를 판정합니다. label 형태는 다음과 같이 설계할 수 있습니다.

- **Binary**: Correct / Incorrect, Faithful / Hallucinated
- **Multi-class**: Good / Partial / Bad
- **Score**: 1\~5 rating, Likert scale

이렇게 만들어진 데이터셋이 **gold reference dataset**이 됩니다.

**AI labelling (LLM Judge)**

동일한 레코드에 대해 LLM에게 judge 역할을 부여합니다. 이때 중요한 것은 **출력을 구조화**하는 것입니다. 예를 들어 `score`와 `explanation`을 포함한 JSON으로 받으면 이후 집계와 오류 분석이 쉬워집니다.

```json
{
  "correctness": "Incorrect",
  "score": 2,
  "explanation": "The agent said Toronto is the capital, but the correct answer is Ottawa."
}
```

**Human label과 AI label 비교하기**

두 가지 label을 모두 확보했다면, 통계적으로 비교해 **LLM judge를 신뢰할 수 있는지** 검증합니다. 이 단계를 건너뛰면 "judge가 잘못 채점한 결과"를 근거로 Agent를 개선하게 됩니다.

**(a) 일치도 지표 (Agreement Metrics)**

- **Exact Match Rate**: human label과 AI label이 동일한 케이스의 비율
- **Cohen's Kappa**: 우연히 일치할 확률을 보정한 지표
- **F1 Score / Precision / Recall**: human label을 ground truth로 간주할 때

**(b) 상관관계 (Correlation)**

label이 수치(score)라면 상관계수를 사용합니다.

- **Pearson correlation**: 선형 관계
- **Spearman correlation**: 순위 관계

**(c) 오류 분석 (Error Analysis)**

AI judge가 사람과 어긋나는 지점을 찾아냅니다.

- judge가 지나치게 관대(too lenient)한가?
- 미묘한 추론 오류(subtle reasoning error)를 놓치는가?
- 문체 차이(stylistic difference)를 과도하게 감점하는가?

### 2-2. LLM Judge

LLM Judge의 일반적인 workflow는 다음과 같습니다.

**① Prompting**

judge LLM에게 Agent의 출력, 원래 task, (선택적으로) ground truth/reference를 함께 제공합니다.

- *User asked*: "What's the capital of Canada?"
- *Agent output*: "Toronto"
- *Correct answer*: "Ottawa"
- *Judge prompt*: "Evaluate whether the answer is correct. Output a score from 1–5."

**② Evaluation Modes**

- **Scoring**: 수치 평가 (1\~5, 0\~100)
- **Categorical judgement**: Correct/Incorrect, Faithful/Unfaithful 등
- **Feedback generation**: 오류 설명과 개선 제안 생성

**③ Aggregation**

여러 번 실행했다면 judge의 점수를 평균합니다. 편향을 줄이기 위해 서로 다른 프롬프트나 모델을 조합한 **multi-judge 구성**을 쓰기도 합니다.

**장점**

- **유연함**: 정확성, 문체, 추론 과정 등 다양한 축을 평가할 수 있음
- **사람 평가보다 빠르고 저렴함**
- **의미적 정확성에 민감함**: "France's capital is Paris"와 "Paris is the capital of France"를 같은 뜻으로 인식

**한계**

- **Bias & subjectivity**: judge LLM이 학습 데이터의 편향을 그대로 물려받을 수 있음
- **Inconsistency**: 같은 케이스에 매번 같은 점수를 주지 않을 수 있음
- **Over-optimism**: 일부 LLM은 지나치게 "친절"해서 틀린 답에도 관대한 점수를 줌
- **Self-evaluation issue**: Agent와 judge가 같은 LLM 계열이면 점수가 부풀려질 수 있음

마지막 항목은 실무에서 특히 조심해야 합니다. 개발 중인 Agent와 채점하는 judge를 같은 모델로 두면, 그 모델이 선호하는 문체와 구조에 후한 점수가 매겨집니다.

### 2-3. 주어진 task를 수행했는지 — Simulation 기반 평가

고정된 ground truth와 비교하는 대신, **task 환경 전체(그리고 필요하다면 사용자까지)를 시뮬레이션**하는 접근입니다. Agent에게 시작 상태를 주고 **환경을 목표 상태로 만들도록** 요구합니다.

**동작 방식**

1. **환경(environment)** 을 시뮬레이션합니다 (예: 실험실, 데이터셋, 소프트웨어 시스템)
2. Agent와 상호작용하는 **사용자(user)** 를 시뮬레이션합니다 (규칙 기반 또는 AI 기반)
3. Agent는 환경에서 행동하고 사용자와 소통하며 task를 해결합니다
4. 다음 두 가지를 평가합니다
    - **목표 달성(Goal achievement)**: 환경이 원하는 상태에 도달했는가?
    - **소통 품질(Communication quality)**: 사용자에게 올바른 답을 전달했는가?

**목적**

이 방식은 **더 유연하고 현실적**입니다. Agent가 **동적인 상호작용에 적응하는 능력**을 평가할 수 있고, **task 완수**와 **human–agent interaction**을 함께 포착하기 때문에 실제 서비스 환경에 가깝습니다.

예를 들어 "데이터셋을 분석해 시뮬레이션된 사용자에게 결과를 설명하라"는 task라면, Agent는 올바른 분석 단계를 선택하고, 시뮬레이션 환경에서 실행하고, 결과를 전달해야 합니다. **분석이 정확한 것과 설명이 효과적인 것 모두**가 성공 조건입니다. 항공권 구매, 소프트웨어 bug fix, 신규 기능 개발처럼 여러 단계를 거쳐야 하는 실무 task가 여기에 해당합니다.

**Example — SWE-bench**

- **Task**: 실제 코드 저장소에서 버그 수정
- **Prompt**: "Function `calculate_discount` sometimes returns negative values. Fix the bug."
- **AI Output**:

```python
def calculate_discount(price, discount):
    result = price - discount
    return max(result, 0)
```

정답 문자열을 비교하는 것이 아니라 **수정된 코드가 테스트를 통과하는지**로 채점한다는 점이 핵심입니다.

**Example — MiniWoB (Shi et al., 2017)**

- **목표**: 언어 지시를 따라 웹 인터페이스와 상호작용하는 Agent 개발
- **Task 예시**: 체크박스 클릭, 드롭다운 메뉴 항목 선택, 폼 작성
- **평가**:
    - **Success Rate (SR)**: 성공적으로 완료한 task의 비율
    - 중간 단계에 부분 점수(partial credit)를 부여해 탐색을 유도
- **구현**: Gym 스타일 API + Selenium 기반 브라우저 자동화

**Agent 평가 시 고려사항**

- **Task Complexity**: 난이도가 다양한 task로 문제 해결 능력을 평가
- **Multimodal Interaction**: 텍스트·이미지 등 여러 형태의 데이터를 통합 처리하는 능력 확인
- **Real-World Applicability**: 벤치마크가 실제로 마주칠 시나리오를 반영하는지
- **Adaptability**: 변화하는 환경과 task에 적응하는 능력
- **Performance Metrics**: task success rate, precision, recall, reasoning accuracy 등으로 정량화

## 3. 세부 평가 방안

앞의 세 가지 접근이 "무엇을 기준으로 볼 것인가"였다면, 여기서는 "Agent의 **어느 단위**를 볼 것인가"를 다룹니다. Agent는 여러 단계를 거치므로, 최종 답변만 보는 것과 중간 과정을 보는 것은 전혀 다른 정보를 줍니다.

### 3-1. 올바른 tool을 사용했는지

Agent가 여러 tool(API, 함수, 플러그인)에 접근할 수 있을 때 확인해야 할 것은 다음 세 가지입니다.

- **Tool name**: 올바른 tool을 선택했는가? (예: calculator vs search)
- **Tool arguments**: tool에 올바른 파라미터·입력을 전달했는가?
- **Correctness**: tool 호출이 올바른 결과를 반환했고, 그 결과를 제대로 활용했는가?

**Example — ToolEmu**

```json
{
  "instruction": "Use the calculator API to find 25 * 17",
  "tools": ["calculator", "calendar", "search"],
  "expected_output": "425"
}
```

**평가**

- ✅ 올바른 tool 선택: `calculator`
- ✅ 올바른 arguments: `25 * 17`
- ✅ 올바른 최종 답변: `425`
- (선택) **효율성**: 한 번의 호출로 해결했는가, 불필요한 추가 호출이 있었는가?

마지막 효율성 항목은 자주 누락되지만 비용과 latency에 직접 연결됩니다. 정답을 맞혔더라도 같은 tool을 세 번 호출했다면 개선 여지가 있습니다.

**Tool/API 벤치마크 정리**

- **Input**: task 지시, 사용 가능한 API/tool/function 목록
- **Output**: tool/API 사용 계획 또는 최종 출력
- **Evaluation Metrics**
    1. 최종 답변 정확도 / task 성공률
    2. 올바른 tool/API 선택 및 사용
    3. 단계별 추론 정확도(stepwise reasoning accuracy)
    4. 견고성(robustness) / 신뢰성 / 효율성

### 3-2. 정답이 맞았는지 (Final Response Evaluation)

가장 직관적인 평가로, 중간 과정과 무관하게 **최종 응답**만 채점합니다.

**Example — GSM8K**

```json
{
  "question": "If a train travels 60 miles in 1.5 hours, how fast is it going in miles per hour?",
  "answer": "40",
  "solution": "Speed = Distance / Time = 60 / 1.5 = 40 mph"
}
```

**Example — ARC (AI2 Reasoning Challenge)**

```json
{
  "question": "Which gas do plants need for photosynthesis?",
  "choices": ["Oxygen", "Carbon dioxide", "Nitrogen", "Hydrogen"],
  "answer": "Carbon dioxide"
}
```

**대표 지표**

1. **Accuracy / Exact Match**: 분류 문제나 수치형 정답
2. **F1-score**: 여러 토큰으로 구성된 답변 (예: QA 데이터셋)
3. **Supporting Facts / Step Accuracy**: 다단계 추론 또는 chain-of-thought task
4. **Programmatic Check**: 수학 퍼즐이나 논리식처럼 코드로 검증 가능한 경우
5. **Semantic Similarity**: 개방형(open-ended) 텍스트 답변

### 3-3. 추론 과정이 논리적인지 (Reference Trajectory)

**Ground Truth Trajectory Evaluation (Next-step Prediction)** 은 Agent가 **다음 행동이나 메시지를 얼마나 잘 예측하는지**로 평가합니다.

여기서 **trajectory**는 상호작용의 연속(sequence)이며, 다음을 포함할 수 있습니다.

- **User messages**: 질문, 명령, 추가 설명 요청
- **Agent messages**: 응답, 해결책
- **Function calls / actions**: 코드 실행, DB 질의, 실험 수행 등

**동작 방식**

1. *ground truth trajectory* 데이터셋을 수집합니다 — 이상적인 행동을 나타내는 상호작용 시퀀스로, 보통 사람이 만들거나 검증된 Agent가 생성합니다
2. Agent에게 이 trajectory의 **prefix**(앞부분 몇 단계)를 제공합니다
3. **다음 단계**(메시지, 행동, function call)를 예측하게 합니다
4. 예측을 ground truth와 비교합니다 — accuracy, F1-score, sequence similarity 등을 사용

**목적**

이 방식은 **통제된 단계별 평가(controlled, step-by-step evaluation)** 입니다. 정해진 시나리오에서 Agent가 "지금 무엇을 해야 하는지 아는가"를 확인하는 데 특히 적합합니다. 예를 들어 사용자가 "이 데이터셋의 추세를 분석해 줘"라고 했을 때, ground truth가 특정 분석 함수 호출이라면 Agent가 동일한 function call을 예측했는지로 점수를 매깁니다.

**Example — Natural Plan benchmark (Zheng et al., 2024)**

```json
{
  "instruction": "Prepare a cup of tea and a sandwich",
  "predicted_plan": ["Boil water", "Steep tea", "Make sandwich", "Serve both"]
}
```

**평가**

- **Plan correctness**: 시퀀스가 지시의 목표를 달성하는가
- **Naturalness / plausibility**: 사람 또는 자동 채점 (선택)

**Example — AGIEval (Zhong et al., 2023)**

실제 시험에서 파생된 human-centric task로 foundation model을 평가합니다.

```json
{
  "question": "What is the derivative of x^2?",
  "choices": ["2x", "x^2", "2x^2", "x"],
  "answer": "2x",
  "rationale": "The derivative of x^2 with respect to x is 2x."
}
```

- **포함된 시험**: SAT, Gaokao, LSAT, GMAT, AMC, AIME, Math Olympiad
- **Metrics**: Accuracy, F1 score
- **Tools**: `lm-evaluation-harness`

**Planning 벤치마크 공통 구조**

- **Input**: 자연어 지시, 초기 상태 또는 task 설명
- **Output**: 다단계 계획(행동의 시퀀스)
- **Evaluation Metrics**
    1. **Plan success / correctness**: 목표를 달성하는가?
    2. **Efficiency / optimality**: 단계 수, 시간, 비용
    3. **Constraint satisfaction**: 규칙과 제약을 지켰는가?
    4. **Execution / simulation-based validation**: 계획을 실행할 수 있는 환경에서의 검증

### 3-4. Graph-Based Evaluation

LangGraph처럼 Agent를 그래프로 구성했다면, 그래프 구조 자체를 평가 기준으로 쓸 수 있습니다.

- **Nodes** = 상태, 하위 task, 의사결정
- **Edges** = 상태 간 유효한 전이(transition)

최종 답변만 확인하는 대신 다음을 봅니다.

- Agent가 그래프에서 **올바른 경로를 따라갔는가?**
- **올바른 중간 node를 올바른 순서로 방문했는가?**
- **유효하지 않은 node나 불필요한 우회를 피했는가?**

이렇게 하면 다음 세 가지를 구분할 수 있습니다.

- **올바른 추론 과정**: 올바른 경로를 거쳐 목표에 도달
- **운 좋은 추측(Lucky guess)**: 정답 node로 점프했지만 추론 단계를 건너뜀
- **Hallucination / error**: 관련 없거나 유효하지 않은 node를 방문

정답률만 보면 첫 번째와 두 번째가 똑같이 "성공"으로 집계됩니다. 하지만 운 좋은 추측은 입력이 조금만 바뀌어도 무너지므로, 실제 서비스에서는 전혀 다른 신뢰도를 가집니다.

**대표 지표**

Graph-based evaluation은 **그래프 이론 + IR 지표**의 아이디어를 응용합니다.

1. **Path Accuracy** — 참조 경로를 정확히 따라갔는지 여부(binary). 예: A → B → C → Goal
2. **Node Accuracy / Coverage** — 참조 node 중 올바르게 방문한 비율. ground truth 경로가 {A, B, C}이고 Agent가 {A, X, C}를 방문했다면 coverage = 2/3
3. **Edge Accuracy / Transition Accuracy** — 올바른 전이를 수행했는가? (A→B, B→C 등)
4. **Edit Distance Between Paths** — Agent 경로와 ground truth 경로 사이의 Levenshtein distance. 값이 작을수록 유사한 행동
5. **Graph Alignment Metrics** — 유효한 경로가 여러 개 존재하는 경우, 단일 "gold path" 대신 허용 가능한 trajectory 집합을 정의하고 그중 **하나와** 정렬되는지 평가
6. **Step-wise Success Rate** — 각 의사결정 단계에서 올바른 node를 선택할 확률

### 3-5. A/B Testing

같은 입력에 대해 **두 개의 Agent 버전 또는 설정**의 성능을 비교하는 방식입니다. 사람이 비교(Human Testing)할 수도 있고 LLM이 비교(AI Testing)할 수도 있습니다. **어떤 변경이 실제로 더 나은 결과를 만드는지** 파악하는 데 가장 직접적인 방법입니다.

[LightRAG 논문](https://arxiv.org/abs/2410.05779)이 좋은 예입니다. 이 논문은 LightRAG와 baseline(GraphRAG)의 답변을 **pairwise로 비교**하도록 LLM judge에게 요청합니다. 평가 기준은 세 가지입니다.

- **Comprehensiveness**: 질문의 모든 측면과 세부사항을 얼마나 자세히 다루는가
- **Diversity**: 질문에 대해 얼마나 다양하고 풍부한 관점과 통찰을 제공하는가
- **Empowerment**: 독자가 주제를 이해하고 정보에 근거한 판단을 내리도록 얼마나 잘 돕는가

![LightRAG 논문의 RAG 평가용 프롬프트. 위쪽 회색 영역은 Comprehensiveness·Diversity·Empowerment 세 기준을 정의하고 각 기준별로 더 나은 답변을 고르게 하는 Evaluation Instruction Prompt, 아래쪽 영역은 질문과 두 답변을 넣고 기준별 Winner와 Explanation, Overall Winner를 JSON으로 출력하도록 지시하는 Evaluation Input Prompt](/images/ai-agent-evaluation/lightrag-eval-prompt.png)

*Figure: RAG 평가용 프롬프트 (LightRAG)*

주목할 점은 프롬프트 설계 방식입니다.

- **기준을 명시적으로 정의**합니다. "더 좋은 답을 골라라"가 아니라 각 기준이 무엇을 의미하는지 문장으로 설명합니다
- **기준별로 Winner와 Explanation을 요구**하고, 그다음에 Overall Winner를 고르게 합니다. 근거를 먼저 쓰게 하면 판정의 일관성이 올라가고, 사람이 사후 검증하기도 쉬워집니다
- **출력을 JSON으로 고정**해 집계 가능한 형태로 만듭니다

아래는 실제 비교 사례입니다. 동일한 질문에 대한 GraphRAG와 LightRAG의 답변, 그리고 LLM judge의 기준별 판정과 근거가 함께 제시되어 있습니다.

![LightRAG와 baseline GraphRAG의 답변을 비교한 case study 표. 동일한 질문에 대한 두 시스템의 답변과 함께 LLM Decision 행에 Comprehensiveness·Diversity·Empowerment·Overall Winner 각각의 판정 결과와 그 이유가 서술되어 있다](/images/ai-agent-evaluation/lightrag-case-study.png)

*Figure: LightRAG vs GraphRAG case study (LightRAG, Table 3)*

이런 pairwise 비교에는 **position bias**(먼저 제시된 답변을 선호하는 경향)가 존재합니다. 그래서 두 답변의 제시 순서를 바꿔 두 번 평가하고 결과를 함께 보고하는 것이 일반적입니다.

## 4. 평가 Framework

Agent 평가를 직접 구축하지 않고 기존 플랫폼을 활용할 수도 있습니다.

1. **LangSmith**
2. **LangFuse**
3. **Google Vertex AI Evaluation Service**
4. **Arize AI's Evaluation Framework**
5. **Galileo Agentic Evaluation**
6. **Patronus AI**
7. **LangChain's AgentEvals**
8. **Databricks Mosaic AI Agent Evaluation** *(주로 RAG 형태의 task를 위해 설계됨)*
9. **Botpress Multi-Agent Evaluation System**
10. **AutoGen**

### 플랫폼의 공통 기능

대부분의 평가 플랫폼은 **Agent trajectory의 지속적 모니터링**을 제공하며, 다음과 같은 핵심 지표를 측정합니다.

- Task completion rate (task 완수율)
- Latency
- Execution speed (실행 속도)
- (일부의 경우) Throughput, 메모리 사용량

## 5. 정리

Agent 평가는 **하나의 지표로 끝나지 않습니다.** 아래처럼 목적에 따라 보는 단위를 골라 조합하는 것이 현실적입니다.

| 무엇을 확인하고 싶은가 | 평가 방안 | 대표 지표 |
| --- | --- | --- |
| 최종 결과가 맞는가 | Final Response Evaluation | Accuracy, Exact Match, F1 |
| 올바른 도구를 썼는가 | Tool 사용 평가 | Tool 선택 정확도, argument 정확도, 호출 효율 |
| 과정이 논리적인가 | Reference Trajectory | Next-step accuracy, sequence similarity |
| 올바른 경로를 지났는가 | Graph-Based Evaluation | Path/Node/Edge accuracy, edit distance |
| 실제 task를 해내는가 | Simulation 기반 평가 | Success Rate, goal achievement, 소통 품질 |
| 어떤 버전이 더 나은가 | A/B Testing | pairwise win rate (기준별) |
| 채점자를 믿을 수 있는가 | Human vs AI label 비교 | Cohen's Kappa, Pearson/Spearman |

특히 강조하고 싶은 두 가지가 있습니다.

**첫째, 최종 답변만 보는 평가는 Agent에 부족합니다.** 정답에 도달한 경로가 올바른지, 불필요한 tool 호출이 없었는지까지 봐야 "운 좋은 성공"과 "신뢰할 수 있는 성공"을 구분할 수 있습니다.

**둘째, 평가자 자체를 평가해야 합니다.** LLM-as-a-Judge는 빠르고 저렴하지만 편향되고 일관성이 낮을 수 있습니다. 소량이라도 human label을 확보해 judge와의 일치도를 검증한 뒤에 judge 점수를 근거로 쓰는 것이 안전합니다.

---

## Reference

- [LightRAG: Simple and Fast Retrieval-Augmented Generation (arXiv:2410.05779)](https://arxiv.org/abs/2410.05779) — 본문 A/B Testing 사례
- [SWE-bench: Can Language Models Resolve Real-World GitHub Issues? (arXiv:2310.06770)](https://arxiv.org/abs/2310.06770)
- [MiniWoB++ (Farama Foundation)](https://miniwob.farama.org/) / [GitHub](https://github.com/Farama-Foundation/miniwob-plusplus)
- [Mind2Web](https://osu-nlp-group.github.io/Mind2Web/)
- [AGIEval (arXiv:2304.06364)](https://arxiv.org/pdf/2304.06364) / [lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness)
- [NATURAL PLAN: Benchmarking LLMs on Natural Language Planning (arXiv:2406.04520)](https://arxiv.org/abs/2406.04520)
- [ToolEmu: Identifying the Risks of LM Agents with an LM-Emulated Sandbox (arXiv:2309.15817)](https://arxiv.org/abs/2309.15817)
- [GSM8K (arXiv:2110.14168)](https://arxiv.org/abs/2110.14168)
- [ARC / AI2 Reasoning Challenge (arXiv:1803.05457)](https://arxiv.org/abs/1803.05457)
- [LangSmith — Evaluation](https://docs.langchain.com/langsmith/evaluation) / [AgentEvals](https://github.com/langchain-ai/agentevals)
- [LangFuse — LLM Evaluation](https://langfuse.com/docs/evaluation/overview)
