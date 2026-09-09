---
title: "RAG 평가, 무엇을 어떻게 측정할 것인가"
date: 2026-09-09
category: ai
summary: RAG 시스템 평가의 목적부터 구성요소별 평가 개념, 대표 지표, 안전성·효율성 평가까지 정리하고 RAG vs GraphRAG 비교 논문을 사례로 살펴봅니다
tags: ["RAG", "GraphRAG", "LLM", "Evaluation", "Benchmark"]
---

> 이 글은 RAG 평가의 **개념과 지표 지도(map)** 를 정리한 글입니다.
> 실제로 소량 데이터셋을 만들어 평가를 돌려 본 실습 기록은 <a href="#" onclick="showPostDetail('2026-09-09-rag-evaluation.md');return false;">내가 만든 RAG는 잘 작동할까?</a> 글에서 다룹니다.

## 1. 평가의 이유와 목적

Evaluation은 단순히 모델의 성능을 측정하는 절차를 넘어, AI 시스템의 **품질 관리, 안정적 운영, 비용 효율화, 리스크 관리**를 위한 핵심 과정입니다.

### 성능 (Performance)

AI 시스템은 다양한 구성요소(모델, 데이터, 인프라, 파이프라인 등)의 상호작용으로 동작합니다. 평가는 이 전체 시스템이 실제 **비즈니스 혹은 운영 목표를 얼마나 잘 달성하는지**를 확인하기 위한 과정입니다.

- **정량적 지표**: Accuracy, F1, Precision/Recall, Latency, Uptime 등 객관적 수치 기반 평가
- **정성적 지표**: 사용자 만족도, 응답 품질, 이해도, 신뢰도 등 사람 중심의 평가 항목
- **목표 연계**: 모든 지표는 조직의 KPI 및 서비스 목표와 연동되어야 하며, 단순 성능 수치가 아닌 "업무·서비스 성과 기여도"로 해석되어야 합니다.
- **지속적 성능 모니터링**: 시스템 업데이트, 모델 교체, 데이터 변화에 따라 평가 기준을 정기적으로 갱신해야 합니다.

### 비용 (Cost)

AI 시스템은 높은 연산 자원과 스토리지를 요구하므로, 평가를 통해 **비용 효율성**을 지속적으로 관리해야 합니다.

- **운영 비용 분석**: 모델 추론 비용(inference cost), 인프라 사용량, 데이터 저장비 등을 주기적으로 모니터링
- **비용–효과 균형**: 동일한 성능을 유지하면서 더 효율적인 모델·하드웨어·파이프라인 구성이 가능한지 평가
- **리소스 최적화**: 오버스펙된 모델이나 비효율적인 데이터 파이프라인을 식별하여 개선
- **ROI 관점 평가**: 단순 비용 절감이 아닌, 시스템 투자 대비 성과(Return on Investment)까지 측정

### 검증 (Validation)

AI 시스템은 **신뢰성과 재현성, 그리고 윤리적 책임**을 보장해야 합니다. 평가 체계는 이러한 요소들을 검증하기 위한 필수 절차입니다.

- **재현성 확보**: 모델 버전, 데이터셋, 파라미터, 환경 설정 등 모든 구성요소를 추적·관리하여 동일 결과의 재현 가능성을 보장
- **품질 기준 통과**: 모델 및 시스템은 배포 전 정의된 품질 게이트(Quality Gate) 또는 승인 절차를 통과
- **윤리·보안 검증**: 데이터 편향, 개인정보 노출, 공격 취약점, 비윤리적 의사결정 등 리스크 요인 평가
- **감사 가능성(Auditability)**: 시스템의 결정 과정과 결과가 사후 감사 및 설명 가능(Explainable)해야 함

### 디버깅 및 운영 안정화 (Debugging)

AI 시스템은 데이터 품질 저하, 모델 드리프트, 외부 환경 변화 등으로 인해 예기치 못한 오류를 발생시킬 수 있습니다. 평가는 이러한 문제를 **조기에 탐지하고 신속히 복구할 수 있는 체계적 관리 도구** 역할을 합니다.

- **이상 탐지 및 알림**: 성능 저하, 응답 오류, 데이터 이상 패턴 등을 실시간으로 감지하고 경고
- **문제 추적**: 로그, 메트릭, 버전 정보 등을 기반으로 문제 원인을 빠르게 식별
- **롤백 메커니즘**: 오류 발생 시 안정된 이전 버전으로 즉시 복귀할 수 있는 체계 확보
- **지속적 개선**: 디버깅 과정에서 확보한 데이터를 학습 및 재평가에 반영하여 시스템의 자기진화(Self-Improvement)를 촉진

---

## 2. 내부 평가 — 구성요소별 (Internal Evaluation)

Vector RAG 파이프라인의 각 단계(Chunking → Embedding → Vector DB → Retriever → Generator)가 무엇을 하는지는 <a href="#" onclick="showPostDetail('2026-09-09-rag-evaluation.md');return false;">실습 편의 "RAG 시스템 구성 요소"</a> 절에 정리해 두었습니다. 여기서는 **각 구성요소를 어떤 관점에서 평가할 것인가**에 집중합니다.

### 검색(Retrieval) 컴포넌트

**1) 관련성 (Relevance: 관련 문서 ↔ 쿼리)**

검색된 문서가 쿼리에서 표현된 정보 요구와 얼마나 잘 일치하는지를 평가합니다. 검색 과정의 **정확도(precision)** 와 **특이성(specificity)** 을 측정합니다.

**2) 포괄성 (Comprehensiveness: 관련 문서 ↔ 관련 문서)**

검색된 문서들의 **다양성(diversity)** 과 **커버리지(coverage)** 를 평가합니다. 즉, 시스템이 주어진 쿼리에 대해 얼마나 폭넓고 다양한 관련 정보를 포착했는지를 측정합니다.

**3) 정확성 (Correctness: 관련 문서 ↔ 후보 문서들)**

검색된 문서들이 후보 문서 집합 중에서 얼마나 정확히 관련 문서를 식별하고 높은 점수를 부여했는지, 즉 **관련 문서를 비관련 문서보다 더 잘 식별하는 능력**을 측정합니다.

### 생성(Generation) 컴포넌트

**1) 관련성 (Relevance: 응답 ↔ 쿼리)**

생성된 응답이 쿼리의 의도와 내용에 얼마나 잘 부합하는지를 측정합니다. 응답이 쿼리 주제와 관련 있고 요구사항을 충족하는지 확인합니다.

**2) 충실성 (Faithfulness: 응답 ↔ 관련 문서)**

응답이 관련 문서에 포함된 정보를 얼마나 정확히 반영하는지 평가합니다. 즉, 생성된 텍스트가 출처 문서의 내용과 **일관성(consistency)** 있게 대응하는지를 측정합니다.

**3) 정확성 (Correctness: 응답 ↔ 샘플 응답)**

샘플 응답(정답) 대비 정확성을 평가합니다. 사실적 정보와 문맥상 타당성 측면에서 응답이 올바른지를 확인합니다.

---

## 3. 기존 평가 방법 (Conventional Evaluation Methods)

### 정보 검색 관련 지표 (Information Retrieval Metrics)

**1) 비순위 기반 지표 (Non-Rank-Based Metrics)**

결과의 순서를 고려하지 않고, 단순히 **관련 여부(이진 결과)** 를 평가합니다.

- **Accuracy / Hit@K**: 전체 결과 중에서 참(True)으로 판정된 비율
- **Recall@K**: 전체 관련 문서 중 상위 K개 내에 검색된 비율
- **Precision@K**: 상위 K개 검색 결과 중 관련 문서의 비율
- **F1 Score**: Precision과 Recall의 조화평균

**2) 순위 기반 지표 (Rank-Based Metrics)**

검색 결과의 **순서적 중요도**를 반영하여 평가합니다.

- **MRR (Mean Reciprocal Rank)**: 첫 번째 정답의 역순위를 평균낸 값
- **NDCG (Normalized Discounted Cumulative Gain)**: 관련 문서가 낮은 순위에 위치할 경우 패널티 부여
- **MAP (Mean Average Precision)**: 쿼리별 평균 정밀도의 평균값

### 자연어 생성 관련 지표 (NLG Metrics)

- **ROUGE**: 요약 품질 평가 지표로, 인간 생성 요약과의 **n-gram, 서열, 쌍어휘 중첩**을 측정
- **BLEU**: 기계 번역 품질 평가 지표이지만 일반 텍스트 생성 평가에도 사용 가능
- **METEOR**: BLEU를 보완하여 **동의어, 어간(stemming), 어순 페널티** 등을 고려
- **BertScore**: BERT 모델을 사용하여 생성 텍스트와 참조 텍스트 간의 **의미적 유사도**를 평가
- **Textual Similarity**: 문서 간 **코사인 유사도(cosine similarity)** 로 의미적 다양성 측정
- **Coverage**: 전체 관련 문서 중 시스템이 검색한 문서의 비율
- **Perplexity (PPL)**: 모델이 문장 분포를 얼마나 잘 학습했는지를 나타내는 확률적 지표

---

## 4. 청킹(Chunking)과 임베딩(Embedding) 평가

### 청킹 (Chunking)

**청크 단위 내 평가 (Intrinsic Evaluation)**

청크 분할 자체의 적절성(문단 논리 일관성 등)을 보는 관점입니다. 자세한 내용은 아래 자료를 참고 부탁드립니다.

- [Evaluating Chunking Strategies for Retrieval (Chroma)](https://research.trychroma.com/evaluating-chunking)
- [Reconstructing Context: Evaluating Advanced Chunking Strategies for Retrieval-Augmented Generation](https://arxiv.org/abs/2504.19754)

**외적 평가 (Extrinsic Evaluation, Downstream Impact)**

- **검색/QA 관련 지표**: Recall, Precision, ROUGE, BLEU, F1 등
- **응답 품질 및 비용**: 더 많은 청크는 정확도 향상과 함께 **계산 비용 증가**를 초래
- **도메인 특화 벤치마크**: 금융·법률·과학 등. 문서 구조(섹션, 표, 주석 등)에 기반한 **구조적 청킹**이 일반적인 고정 길이 분할보다 효율적일 수 있음

### 임베딩 (Embedding)

[MTEB: Massive Text Embedding Benchmark](https://arxiv.org/abs/2210.07316)와 [MMTEB: Massive Multilingual Text Embedding Benchmark](https://arxiv.org/abs/2502.13595)가 표준 평가 벤치마크로 사용됩니다. 개별 지표와 태스크 구성은 위 두 논문을 참고 부탁드립니다.

---

## 5. LLM 기반 평가

### LLM 출력 기반 평가 (LLM Output-Based Evaluation)

**1) LLM-as-a-Judge**

LLM에게 직접 평가 프롬프트를 주어 생성 결과를 점수화합니다. (예: RAGAS, Databricks Eval)

> **주의**: 평가 자체에 bias가 생길 수 있습니다. 대표적으로 **position bias**(선택지 제시 순서에 따라 평가가 달라지는 현상)가 있습니다. 참고: [RAG vs. GraphRAG: A Systematic Evaluation and Key Insights](https://arxiv.org/abs/2502.11371)

**2) Semantic Perplexity (SePer)**

LLM의 내부 신념을 기반으로 응답의 정답 가능성을 추정합니다.

**3) KPR Metric**

검색된 문서의 핵심 내용을 얼마나 잘 반영했는지를 평가합니다.

**4) MRWR / MRLR**

RAG 내 서로 다른 리트리버(retriever) 간 일관성을 평가합니다.

**5) FactScore**

생성된 텍스트를 **원문 지식베이스와의 일치 여부**로 평가합니다. 사실 단위로 분해하여 매칭을 수행합니다.

**6) Risky Evaluation**

- **Risk**: 위험 사례의 비율
- **Carefulness**: 잘못된 결과를 걸러낸 비율
- **Alignment**: 시스템의 판단이 정답 라벨과 일치하는 비율
- **Coverage**: 유지된 샘플의 비율

참고: [Controlling Risk of Retrieval-augmented Generation: A Counterfactual Prompting Framework](https://arxiv.org/abs/2409.16146)

### LLM 표현 기반 평가 (Representation-Based Evaluation)

LLM의 중간 혹은 마지막 레이어의 벡터 표현을 활용하여, 내재된 표현 정보를 기반으로 평가를 수행합니다. LLM 내부 임베딩에 대한 접근이 필요한 방식으로, 자세한 내용은 [Evaluation of Retrieval-Augmented Generation: A Survey](https://arxiv.org/abs/2405.07437)와 [Retrieval Augmented Generation Evaluation in the Era of Large Language Models: A Comprehensive Survey](https://arxiv.org/abs/2504.14891)를 참고 부탁드립니다.

---

## 6. 외부 평가 (External Evaluation)

### 안전성 평가 (Safety Evaluation)

**1) 견고성 (Robustness)**

잘못된 정보가 포함된 검색 결과에도 시스템이 얼마나 안정적으로 작동하는지 평가합니다.

**2) 사실성 (Factuality)**

허위 생성(hallucination)을 방지하고 정확한 정보만을 생성하는 능력을 평가합니다.

- Factual Accuracy
- Hallucination Rate
- Citation Precision / Recall
- Faithfulness Metrics

**3) 적대적 공격 (Adversarial Attacks)**

RAG 파이프라인의 특정 구성요소를 목표로 한 공격을 평가합니다. 예: **PoisonedRAG**(악의적 텍스트 주입) → **Attack Success Rate (ASR)**, Precision/Recall/F1로 평가.

**4) 프라이버시 (Privacy)**

검색 DB나 쿼리에서 개인정보가 노출될 위험을 평가합니다. → **Extraction Success Rate** 사용.

**5) 공정성 (Fairness)**

시스템이 특정 집단에 대한 편향을 재생산하거나 증폭하는지 평가합니다.

- **편향 지표(Bias Metrics)**: 출력 결과의 bias를 분석하기 위해 사용되며, 인구통계학적 집단 간의 성능 격차(오류율, 감정 점수 등)를 정량적으로 측정
- **고정관념 탐지(Stereotype Detection)**: 생성된 텍스트 내 해로운 고정관념의 빈도나 심각도를 측정. 미리 정의된 목록이나 사람에 의한 평가로 수행
- **반사실적 공정성(Counterfactual Fairness)**: 질의나 맥락에서 민감한 속성(성별, 인종 등)을 변경했을 때 출력이 부적절하게 달라지는지 확인

**6) 투명성 / 책임성 (Transparency / Accountability)**

시스템의 추론 과정을 이해하고 검증할 수 있는지 평가합니다.

- **설명 품질(Explanation Quality)**: 설명이나 출처 정보(provenance)의 **명확성, 완전성, 유용성**에 대한 사람의 평가 점수
- **추적 가능성(Traceability)**: 최종 출력 결과를 **특정 출처 문서나 문단으로 얼마나 쉽게 연결할 수 있는지**

### 효율성 평가 (Efficiency Evaluation)

**1) 지연 시간 (Latency)**

- **TTFT (Time to First Token)**: 첫 토큰 생성까지의 시간
- **Total Latency**: 전체 응답 생성까지의 시간

**2) 자원 및 비용 (Resources and Cost)**

RAG 시스템의 총비용은 다음 요소로 구성됩니다.

1. 인프라 비용 (임베딩, 벡터DB, LLM 추론 등)
2. 토큰 기반 API 비용
3. 스토리지 비용
4. 운영·유지보수 비용
5. 개발 및 통합 비용

대표 지표는 다음과 같습니다.

- **Cost-Effectiveness Ratio**: 비용 대비 성능 향상 비율
- **Retrieval Precision ROI**: 검색 정확도 개선에 따른 비용 절감 효과
- **Cost-Accuracy Tradeoff (α 파라미터)**
- **Comparative Cost Analysis**: 구현 간 상대적 경제성 평가

---

## 7. 요약

### 🧩 무엇을 평가하는가 (Component-Based Evaluation)

| 구분 | 하위 항목 | 평가 목적 | 주요 평가 기준 / 포인트 |
| --- | --- | --- | --- |
| **검색 (Retrieval)** | 관련성 (Relevance) | 문서가 쿼리 의도와 얼마나 잘 맞는가 | Precision, Specificity |
|  | 포괄성 (Comprehensiveness) | 관련 정보의 범위와 다양성 | Coverage, Diversity |
|  | 정확성 (Correctness) | 관련 문서를 비관련 문서보다 잘 식별했는가 | Ranking Accuracy, MAP |
| **생성 (Generation)** | 관련성 (Relevance) | 응답이 쿼리 요구와 일치하는가 | Semantic Similarity, BLEU, ROUGE |
|  | 충실성 (Faithfulness) | 응답이 근거 문서를 얼마나 충실히 반영하는가 | Faithfulness Score, Citation Precision/Recall |
|  | 정확성 (Correctness) | 응답이 사실적으로 정확하고 타당한가 | FactScore, BertScore |
| **청킹 (Chunking)** | 내적 평가 | 청크 분할의 적절성 | 문단 논리 일관성 등 |
|  | 외적 평가 | QA·검색 성능에 미치는 영향 | Recall, Precision, F1, 비용 증가율 |
| **임베딩 (Embedding)** | 표현 품질 | 문서 표현의 품질 및 의미 일관성 | MTEB, MMTEB 벤치마크 |
| **외부 평가 (External)** | 안전성 / 견고성 | 오류·공격에도 안정적 작동 여부 | Factuality, ASR, Hallucination Rate |
|  | 공정성 / 편향 | 특정 집단에 대한 편향성 평가 | Bias Metrics, Stereotype Detection |
|  | 투명성 / 책임성 | 추론 과정의 이해 가능성 | Explanation Quality, Traceability |
| **효율성 (Efficiency)** | 지연 시간 | 응답 생성 속도 | TTFT, Total Latency |
|  | 비용 / 자원 | 비용 대비 성능 | Cost-Effectiveness Ratio, Tradeoff Analysis |

### ⚙️ 어떻게 평가하는가 (Method-Based Evaluation)

| 평가 방법 | 적용 대상 | 핵심 개념 / 접근 방식 | 대표 지표 / 예시 |
| --- | --- | --- | --- |
| **정보 검색 지표 (IR Metrics)** | 검색 품질 | 검색 결과의 정확도·순위 품질 평가 | Accuracy, Recall@K, Precision@K, MRR, NDCG, MAP |
| **자연어 생성 지표 (NLG Metrics)** | 생성 품질 | 텍스트 생성 결과의 품질·유사도 평가 | ROUGE, BLEU, METEOR, BertScore, Perplexity |
| **LLM 출력 기반 평가 (LLM-as-a-Judge)** | 생성/검색 모두 | LLM이 결과를 직접 평가하는 자동화 평가 | RAGAS, Databricks Eval, SePer, KPR, MRWR, MRLR, FactScore, Risky Eval |
| **LLM 표현 기반 평가 (Representation-Based)** | 생성·검색 | LLM 내부 벡터 비교를 통한 품질 평가 | Embedding Similarity, Representation Alignment |
| **외부 품질 평가 (Safety / Fairness / Robustness)** | 전체 시스템 | 안전성·공정성·사실성 등 신뢰성 평가 | Factual Accuracy, Hallucination Rate, Bias Metrics, ASR |
| **효율성 평가 (Efficiency Metrics)** | 시스템 운영 | 시간·비용·자원 효율성 평가 | TTFT, Total Latency, Cost-Effectiveness, ROI |
| **청킹/임베딩 특화 벤치마크** | 문서 처리 구조 | 데이터 구조 및 표현의 품질 평가 | MTEB, MMTEB, Domain-specific Benchmarks |

---

## 8. 평가 사례: RAG vs GraphRAG

지금까지의 지표들이 실제 논문에서 어떻게 쓰이는지 보기 위해, RAG와 GraphRAG를 체계적으로 비교한 [RAG vs. GraphRAG: A Systematic Evaluation and Key Insights](https://arxiv.org/abs/2502.11371) 논문을 살펴봤습니다.

> 아래의 모든 표와 그림은 [RAG vs. GraphRAG: A Systematic Evaluation and Key Insights](https://arxiv.org/abs/2502.11371)에서 인용한 것입니다.

### 논문의 Contribution

이 논문은 **LLM이 외부 지식을 활용하는 두 가지 방법**을 비교합니다.

- **RAG (Retrieval-Augmented Generation)**: 관련 텍스트 청크를 검색
- **GraphRAG (Graph-based RAG)**: 그래프(엔티티와 관계) 형태로 조직된 정보를 검색

핵심 질문은 **"둘 중 어느 방법이 더 잘 작동하는가? 언제, 왜 그런가?"** 입니다.

**실험 설정**

1. **두 가지 주요 작업에 대해 성능 비교**
    - **Question Answering (QA)** — 구체적인 질문에 답변 생성
    - **Query-based Summarization** — 사용자 질의에 기반한 요약 생성
2. **대표적인 공개 데이터셋** 사용
3. **표준 평가 지표**로 정량적 비교 (Precision, Recall, F1, ROUGE, BERTScore)
4. **두 가지 Hybrid 전략 제안**
    - **Selection**: 질의 유형에 따라 RAG 또는 GraphRAG 선택 (QA 전용)
    - **Integration**: 두 시스템의 검색 결과를 결합 (QA와 Summarization 모두)

### 평가 데이터셋

**(a) Question Answering**

- **Datasets**
    - *Natural Questions (NQ)* — single-hop QA
    - *HotPotQA* — multi-hop QA
    - *MultiHop-RAG* — multi-document, multi-hop QA
    - *NovelQA* — long-text QA (fiction novels)
- **Metrics**
    - Precision, Recall, F1 (NQ, HotpotQA)
    - Accuracy (MultiHop-RAG, NovelQA)

**(b) Query-based Summarization**

- **Datasets**
    - *SQuALITY*, *QMSum* (single-document)
    - *ODSum-story*, *ODSum-meeting* (multi-document)
- **Metrics**
    - ROUGE-2 (lexical overlap)
    - BERTScore (semantic similarity)

### (a) 실험 결과 — QA

RAG와 GraphRAG는 각각 **뚜렷하게 구분되는 강점**을 가지고 있었습니다.

**🟦 RAG의 강점**

1. **세부적·직접적 질문에 강함**
    - **Single-hop** 질의에서 가장 뛰어남 (예: "Who discovered penicillin?")
    - 텍스트 청크 전체를 의미 기반으로 검색하므로 **문맥이 풍부한 정보**를 제공
2. **높은 사실 정확도**
    - 원문 텍스트를 그대로 사용하므로 세부 정보 손실이 적고 표현이 정확함
    - 특히 **Natural Questions (NQ)** 에서 Precision과 F1이 가장 높음

**🔴 RAG의 약점**

- **Multi-hop reasoning**이 약함 → 여러 문서에 흩어진 사실을 연결하기 어려움
- 중복된 텍스트 청크를 검색해 **Context 낭비** 발생
- **엔티티 관계 구조**를 명시적으로 모델링하지 않음

**🟦 GraphRAG의 강점**

- **넓은 문서 전반의 문맥**을 요약적으로 파악
- **비교·시간적 질의** 등 **big-picture reasoning**에 유리
- 명시적 **엔티티-관계 추론** 가능

**🔴 GraphRAG의 약점**

- 세부 사실을 놓쳐 정확도가 낮고 **hallucination** 발생 가능
- 정보가 부족한 상황에서도 답을 만들어내는 경향 (null-answer 문제)

![NQ·Hotpot·MultiHop-RAG·NovelQA 데이터셋에 대한 RAG와 GraphRAG 변형들의 Precision/Recall/F1 성능 비교표](/images/rag-evaluation/qa-performance-tables.png)

*Tables 1–3: 데이터셋별 성능 비교*

두 방법이 서로 다른 문제를 맞히고 틀린다는 점은 confusion matrix에서도 확인됩니다. 네 데이터셋 모두에서 **한쪽만 맞히는 영역이 상당한 비중**을 차지합니다.

![NQ, Hotpot, MultiHop-RAG, NovelQA 각각에 대해 RAG 정답 여부와 GraphRAG 정답 여부를 교차한 2x2 혼동 행렬](/images/rag-evaluation/qa-confusion-matrix.png)

*Figure: RAG와 GraphRAG의 정답/오답 교차 분포*

**논문이 제안한 전략**

- **Selection**: 질의가 "fact-based"면 RAG, "reasoning-based"면 GraphRAG를 사용합니다. 질의 분류는 아래와 같은 프롬프트로 수행합니다.

![질의를 Fact-Based와 Reasoning-Based로 분류하는 시스템 프롬프트 전문](/images/rag-evaluation/query-classification-prompt.png)

*Figure 5: Prompt for Query Classification*

- **Integration**: 두 시스템의 검색 결과를 결합합니다. RAG의 텍스트 청크와 GraphRAG의 그래프 요약을 함께 LLM에 입력합니다.

두 방안 모두 성능을 높이는 것으로 나타났고, 특히 **Integration**의 성능이 높게 측정되었습니다.

![Llama3.1-8B와 70B에서 RAG, GraphRAG, Selection, Integration의 QA 성능을 데이터셋별로 비교한 막대그래프](/images/rag-evaluation/qa-overall-comparison.png)

*Figure 3: Overall QA performance comparison*

### (b) 실험 결과 — Summarization

**🟦 RAG의 강점**

- 단일·다중 문서 요약 모두에서 **가장 안정적인 성능**
- **정확하고 포괄적인 요약** 생성 (높은 ROUGE-2, BERTScore)
- LLM-as-a-Judge 평가에서 **Comprehensiveness(충실도)** 최고점

**🔴 RAG의 약점**

- 세부 중심으로 좁게 요약 → **전반적 다양성(Diversity)** 이 낮음
- 주제 간 연결이나 상위 구조를 누락할 수 있음

**🟦 GraphRAG의 강점**

- RAG에 근접한 성능 (특히 단일 문서 요약)
- 엔티티·관계 정보를 포함해 구조적 인식 가능
- **균형 잡힌 요약** 생성, LLM-as-a-Judge에서 **Diversity** 항목 우수

**🔴 GraphRAG의 약점**

- 세부 정보 손실로 ROUGE/BERTScore가 낮음
- Query-specific 세부 요약에는 부적합 (예: SQuALITY, QMSum)
- 그래프 품질이 결과에 큰 영향을 미침

**🟦 Integration(RAG + GraphRAG)의 강점**

1. **정보의 균형** — 세부와 구조를 함께 확보
    - RAG → 세부 사실 중심
    - GraphRAG → 전반적 구조·연관성 중심
2. **데이터셋 전반에서 안정적 성능**
    - 네 개 데이터셋(SQuALITY, QMSum, ODSum-story, ODSum-meeting) 모두에서 일관된 결과
    - 예: **ODSum-meeting**의 ROUGE-2 F1 — RAG 8.77 / GraphRAG (Local) 8.02 / **Integration 8.51**

**🔴 Integration의 약점**

1. 요약이 **중복·장황**해질 수 있음
2. RAG 단독 대비 **큰 성능 향상은 아님**
3. **비용↑, 효율↓** — 두 시스템을 모두 실행해야 함

> **참고**: Selection 전략은 Summarization에는 적용되지 않았습니다(Integration만 사용). 요약은 글의 세부 정보와 전체 맥락을 모두 고려해야 하기 때문에 selection 전략에 적합하지 않다는 것이 저자의 판단입니다.

![SQuALITY, QMSum, ODSum-story, ODSum-meeting에 대한 요약 성능을 ROUGE-2와 BERTScore로 비교한 표](/images/rag-evaluation/summarization-performance-tables.png)

*Tables 4–5: 질의 기반 요약 성능*

![QMSum과 ODSum-story에 대해 Comprehensiveness와 Diversity 항목에서 RAG와 GraphRAG의 LLM-as-a-Judge 선호 비율을 제시 순서별로 비교한 막대그래프](/images/rag-evaluation/llm-as-judge-summarization.png)

*Figure 4: LLM-as-a-Judge 평가 결과. Order 1과 Order 2의 차이가 곧 **position bias**입니다.*

마지막 그림은 앞서 언급한 **position bias**를 잘 보여줍니다. 같은 두 시스템을 비교하는데도 **어떤 응답을 먼저 제시하느냐(Order 1 / Order 2)에 따라 승률이 크게 뒤집힙니다.** LLM-as-a-Judge를 사용할 때 순서를 바꿔 가며 두 번 평가해야 하는 이유입니다.

### ⚖️ 정리

| Task | Method | 강점 | 약점 |
| --- | --- | --- | --- |
| **QA** | **RAG** | 사실 기반, single-hop 질의에 강함 | multi-hop reasoning에 약함 |
|  | **GraphRAG (Local)** | multi-hop, 추론 중심 질의에 강함 | 세부 정보 손실, 비용 높음 |
|  | **GraphRAG (Global)** | 전체 문맥 이해에 강함 | 세부 누락, hallucination |
|  | **KG-GraphRAG** | 명시적인 지식 그래프 관계를 활용해 구조적으로 정보를 연결 | 그래프 자체가 불완전하거나 관계 누락이 많아 전반적 성능은 낮음 |
| **Summarization** | **RAG** | 충실하고 세부적인 요약 | 다양성 부족 |
|  | **GraphRAG (Local)** | 세부 + 구조 균형 | 약간 낮은 점수 |
|  | **GraphRAG (Global)** | 폭넓은 주제 커버리지 | 세부 정확도 낮음 |
|  | **KG-GraphRAG** | 출력값 제한 | 세부 정확도 낮음, 문장이 유창하지 않음 |
|  | **Integration (RAG+GraphRAG)** | 세부+구조 균형, 안정적 성능 | 계산 비용 높고 큰 개선은 없음 |

---

## Reference

- [Hugging Face Cookbook — RAG Evaluation](https://huggingface.co/learn/cookbook/rag_evaluation)
- [OpenAI Cookbook — Evaluate RAG with LlamaIndex](https://cookbook.openai.com/examples/evaluation/evaluate_rag_with_llamaindex)
- [LangSmith — Evaluation approaches (RAG)](https://docs.langchain.com/langsmith/evaluation-approaches#retrieval-augmented-generation-rag)
- [Awesome-RAG-Evaluation (GitHub)](https://github.com/YHPeter/Awesome-RAG-Evaluation)
- [Evaluation of Retrieval-Augmented Generation: A Survey](https://arxiv.org/abs/2405.07437)
- [Retrieval Augmented Generation Evaluation in the Era of Large Language Models: A Comprehensive Survey](https://arxiv.org/abs/2504.14891)
- [RAG vs. GraphRAG: A Systematic Evaluation and Key Insights](https://arxiv.org/abs/2502.11371) — 본문 8장 사례
- [Controlling Risk of Retrieval-augmented Generation: A Counterfactual Prompting Framework](https://arxiv.org/abs/2409.16146)
- [Evaluating Chunking Strategies for Retrieval (Chroma)](https://research.trychroma.com/evaluating-chunking)
- [Reconstructing Context: Evaluating Advanced Chunking Strategies for Retrieval-Augmented Generation](https://arxiv.org/abs/2504.19754)
- [MTEB: Massive Text Embedding Benchmark](https://arxiv.org/abs/2210.07316)
- [MMTEB: Massive Multilingual Text Embedding Benchmark](https://arxiv.org/abs/2502.13595)

**읽어볼 논문**

- [On the Theoretical Limitations of Embedding-Based Retrieval](https://arxiv.org/abs/2508.21038)
