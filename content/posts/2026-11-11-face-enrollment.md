---
title: "Smart CCTV, 얼굴 등록(Face Enrollment)과 Gallery DB 설계"
date: 2026-11-11
category: ai
summary: 사전학습 임베딩 모델로 1:N 얼굴 식별 서비스를 만들 때, 모델 선택 이후에 남는 gallery DB와 API 설계를 정리합니다. 무엇을 저장할지, 정면 1장과 다각도 N-shot 등록 전략, staging 후 commit하는 등록 프로토콜, gallery 크기에 맞춘 threshold(FMR vs FPIR)와 exact search·ANN 선택, 악의적 등록 대응, 템플릿 암호화, 동의·폐기 같은 법적 절차, 모델 마이그레이션과 운영 모니터링까지 다룹니다.
tags: ["Smart CCTV", "Face Recognition", "Face Enrollment", "Vector Search", "Privacy", "Computer Vision"]
series: Smart CCTV
series_order: 4
---

## Intro

얼굴 인식 모델을 고른 뒤에 남는 결정의 대부분은 gallery DB와 API 설계에 있습니다. 어떤 값을 어떤 형태로 저장할지, 한 사람당 몇 장을 등록할지, 검색 결과를 어떤 기준으로 수락할지, 유출되면 무엇을 잃는지 등이 모두 여기서 정해집니다.

다루는 것
- 이 글은 사전학습된 임베딩 모델(ArcFace 계열)을 그대로 쓰는 **1:N 식별 서비스**를 전제로 합니다. 

다루지 않는 것
- AI 모델 학습 방법, AI 모델의 내부 구조는 다루지 않습니다. 

주의: 예제 코드는 이해를 돕기 위한 것이며 production 코드가 아닙니다.

### 용어

| 용어 | 뜻 |
| --- | --- |
| Gallery | 등록된 사람들의 템플릿 모음. 이 글에서 설계하는 대상 |
| Probe | 인증 시점에 들어온 얼굴에서 뽑은 임베딩 |
| Template | 한 사람을 대표하는 임베딩 한 개 또는 여러 개 |
| Enrollment | 템플릿을 gallery에 넣는 절차 |
| FMR / FNMR | 1:1 비교에서 타인을 수락하는 비율 / 본인을 거절하는 비율 |
| FPIR / FNIR | 1:N 검색에서 미등록자가 누군가로 식별되는 비율 / 등록자를 찾지 못하는 비율 |

현업에서는 FAR/FRR이라는 말을 1:1과 1:N 구분 없이 씁니다. 둘은 다른 지표이고, 이 차이가 뒤의 threshold 설계에서 중요해집니다. 이 글에서는 구분이 필요한 곳에서만 FMR과 FPIR을 따로 씁니다.

### 전체 흐름

얼굴 등록(Face Enrollment)과 얼굴 식별(Face Recognition)은 같은 전처리와 같은 모델을 공유하고, 마지막 단계만 달라야합니다.

1. **캡처**: 클라이언트가 얼굴 프레임(이미지)을 보냅니다.
2. **검출·정렬**: 이미지에서 얼굴과 landmark를 찾고 112×112로 정렬합니다.
3. **검사**: liveness와 이미지 품질을 확인합니다.
4. **임베딩**: 임베딩 모델이 이미지에서 512차원 벡터를 산출합니다.
5. **등록일 때**: staging에 쌓고, 조건을 만족하면 한 트랜잭션으로 gallery에 commit합니다.
6. **식별일 때**: gallery를 검색하고 threshold로 매칭 여부를 정한 뒤 결과를 기록합니다.

글은 저장 설계, 등록 전략, 등록 프로토콜, 검색과 판정, 공격 대응, 템플릿 보호, 법적 절차, 폐기, 마이그레이션, 모니터링 순으로 진행합니다.

## 1. 무엇을 저장할 것인가

Gallery에는 "어떤 모델이, 어떤 조건에서 뽑은, 누구의 벡터인가"에 관련한 데이터가 저장되어있어야 합니다. 
간단히 해당 사람의 식별자(ID)와 임베딩 벡터만 저장하면 나중에 모델을 바꾸거나 오인식 원인을 추적할 때 되돌릴 방법이 없습니다.

### 모델 버전은 벡터와 같은 행에 둔다

임베딩(Embedding)은 서로 다른 데이터와 아키텍처로 학습되는 순간 고유의 벡터 공간을 형성하기 때문에, 모델 간 직접적인 유사도 비교는 무의미해집니다. 심지어 동일한 데이터와 아키텍처로 학습하더라도, 학습 과정의 확률적(Probabilistic) 특성에 의해 가중치가 달라져 임베딩 벡터 공간의 정렬이 어긋나게 됩니다.

이로 인해 얼굴 등록은 `model-v1`으로 수행하고, 인증은 `model-v2`로 수행할 경우, 시스템 에러(Error) 없이 오인증/오류(Silent Failure)’가 발생할 수 있습니다.

따라서 데이터베이스에 임베딩 벡터를 저장할 때 반드시 `model_name`과 `model_version` 메타데이터를 함께 기록하고, 검색 및 비교 쿼리 시 항상 해당 버전으로 필터링하도록 아키텍처를 설계해야 합니다.


특히 얼굴 인식 시스템에서는 인식 모델(Recognition Model)뿐만 아니라 얼굴 검출 모델(Detector)과 정렬 방식(Alignment) 역시 버전 관리의 필수 요소입니다. 
정렬 기준점이나 검출 영역이 조금만 달라져도 인식 모델에 입력되는 데이터 분포가 완전히 깨져 정상적인 유사도 비교가 불가능해지기 때문입니다.

**아키텍처 설계 원칙**
- 파이프라인 전체를 식별하는 메타데이터 관리
    - 데이터베이스에 임베딩 벡터를 저장할 때, 인식 모델뿐만 아니라 검출기와 정렬 방식을 포함한 전체 파이프라인 구성을 문자열 형태로 함께 기록합니다.
    - 예시 파이프라인 식별자: `arcface-r100 + scrfd-10g + align-v1`
- 검색 및 비교 쿼리 필터링 강제
    - 벡터 검색(Vector Search) 수행 시, 쿼리 생성에 사용된 파이프라인 메타데이터(`model_name`, `model_version` 등)와 일치하는 데이터만 대상으로 필터링을 강제합니다.

### L2 정규화한 값을 저장하고, norm은 따로 둔다

ArcFace 계열 모델은 코사인 유사도(Cosine Similarity)를 지표로 삼아 학습되므로, 갤러리(Gallery)와 프로브(Probe) 간의 비교 역시 코사인 유사도를 기반으로 수행해야 합니다 \[1\]. 

이때 임베딩 벡터를 미리 L2 정규화(Normalization)하여 저장하면, 벡터 간의 **내적(Dot Product)** 연산만으로 코사인 유사도를 바로 도출할 수 있습니다. 이를 통해 검색 로직과 벡터 인덱스 설정을 단순화할 수 있을 뿐만 아니라, 대규모 비교 연산 시 처리 속도를 크게 향상시킬 수 있습니다.
```py
import numpy as np

def verify_face(probe_embedding: np.ndarray, gallery_id: str):
  # 1. DB에서 L2 정규화가 완료된 갤러리 벡터들을 가져옴 (Pseudo code)
  # Shape: (N, D)
  gallery_vectors = fetch_gallery_vectors(gallery_id)

  # 2. Probe 벡터 L2 정규화 수행
  probe_norm = np.linalg.norm(probe_embedding)
  if probe_norm == 0:
    raise ValueError("Probe vector norm is zero.")

  normalized_probe = probe_embedding / probe_norm

  # 3. 코사인 유사도 계산
  # similarity = dot(A, B) / (||A|| * ||B||)
  # 갤러리 벡터가 이미 L2 정규화되어 있으므로 
  # probe_norm과의 단순 내적(Dot Product)이 곧 코사인 유사도가 됨
  similarity_scores = np.dot(
    gallery_vectors, 
    normalized_probe
  )  

  # Shape: (N,)
  return similarity_scores
```

정규화 이전의 원본(Raw) 벡터 크기(Norm)에는 얼굴 이미지의 품질과 관련된 유의미한 정보가 내포되어 있습니다 \[2\].

일반적으로 원본 벡터의 크기가 클수록 모델은 해당 이미지를 **선명도가 높고, 정면에 가까우며, 신원 식별이 명확한 고품질**로 판단하는 경향이 있습니다.
반대로 벡터의 크기가 작다면 **블러(Blur), 불리한 조도, 극단적인 포즈(Pose), 오클루전(Occlusion)** 등으로 인해 모델이 인식하기에 불확실하고 품질이 낮은 이미지임을 뜻합니다.

따라서 원본 벡터 전체를 그대로 보관하는 대신, **L2 정규화 벡터와 원본 벡터의 크기를 담은 `raw_norm` 스칼라 값**을 분리하여 저장하는 방식을 권장합니다. 이를 통해 **이미지 품질에 대한 신호는 유실 없이 보존하면서도, 벡터 저장 및 유사도 비교 형식을 효율적으로 일원화**할 수 있습니다.

### 세션 메타는 "나중에 판단에 쓸 것"만 남긴다

메타데이터도 개인정보이므로 많이 남길수록 좋은 것이 아닙니다. 각 필드가 어떤 결정에 쓰이는지 답할 수 있는 것만 저장합니다.

| 필드 | 쓰임 |
| --- | --- |
| `model_version` | 검색 필터, 마이그레이션 대상 식별 |
| `consent_id` | 어떤 버전의 동의에 근거한 등록인지 증빙 |
| `pose_bucket`, `yaw`, `pitch` | 템플릿 선택, 각도별 인식률 분석 |
| `quality_score`, `raw_norm` | 저품질 템플릿 교체 대상 선정 |
| `is_initial` | 최초 등록과 재등록 구분 |
| `device_info`, `client_app_version` | 특정 기기나 앱 버전의 캡처 문제 추적 |
| `enrolled_by_staff_id` | 공용 기기에서 감독자 입회하에 등록한 경우의 책임 추적 |

### 스키마

벡터 컬럼은 pgvector 확장의 `vector(512)`를 기준으로 적었습니다 \[3\]. 확장을 쓰지 않거나 애플리케이션 레벨 암호화를 적용하면 `bytea`로 바꿉니다. `subject_ref`는 회원 ID가 아닌 가명 키이며, 이유는 6장에서 다룹니다.

**`face_templates`**: gallery 본체

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `template_id` | `uuid` PK |  |
| `subject_ref` | `uuid` NOT NULL | 가명 키. 회원 테이블과 직접 FK를 걸지 않음 |
| `model_version` | `text` NOT NULL | 파이프라인 전체 버전 |
| `embedding` | `vector(512)` NOT NULL | L2 정규화 float32 |
| `raw_norm` | `real` | 정규화 전 크기 |
| `pose_bucket` | `text` | `front` / `left` / `right` / `up` / `down` |
| `yaw`, `pitch` | `real` | 등록 시점 추정 각도(도) |
| `quality_score` | `real` | FIQA 점수 |
| `session_id` | `uuid` FK | 어느 등록 세션에서 왔는지 |
| `status` | `text` NOT NULL | `active` / `retired` |
| `created_at` | `timestamptz` NOT NULL |  |

인덱스는 `(model_version, status)`와 `(subject_ref)`에 둡니다. 벡터 인덱스는 4장에서 필요 여부부터 판단합니다.

**`enrollment_sessions`**: 등록 한 번의 맥락

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `session_id` | `uuid` PK |  |
| `subject_ref` | `uuid` NOT NULL |  |
| `status` | `text` NOT NULL | `open` / `committed` / held / `aborted` / `expired` |
| `model_version` | `text` NOT NULL | 세션 시작 시점에 고정 |
| `consent_id` | `uuid` FK NOT NULL | 동의 없이는 세션을 열 수 없음 |
| `is_initial` | `boolean` NOT NULL |  |
| `device_info` | `jsonb` | 기기 모델, 카메라 해상도 등 |
| `client_app_version` | `text` |  |
| `enrolled_by_staff_id` | `uuid` NULL | 본인 기기 등록이면 NULL |
| `created_at`, `expires_at`, `committed_at` | `timestamptz` |  |

## 2. 등록 전략: 정면 1장인가, 다각도 N-shot인가

가장 단순한 등록은 정면 사진 1장입니다.
Probe가 항상 정면으로 협조하는 환경(e.g., Apple Face ID)이라면 이것으로 충분할 수 있습니다.
다각도 N-shot은 등록 UX와 저장·검색 비용을 늘리므로, 도입하려면 아래 두 질문에 답할 수 있어야 합니다.

### 질문 1. 정렬 모듈이 존재하는데 다각도 등록이 필요한지?

정렬 모듈은 모든 얼굴을 정면으로 돌려 주지 않습니다.
InsightFace류의 정렬은 landmark 5점을 기준 좌표에 맞추는 2D similarity transform입니다.
이 변환으로 보정되는 것은 이미지 평면 안의 변화, 즉 평면 내 회전(roll), 크기, 위치입니다.
고개를 좌우(yaw)나 상하(pitch)로 돌린 것은 이미지 평면 밖의 회전이라 그대로 남습니다.
옆얼굴은 정렬 후에도 옆얼굴이고, 가려진 반쪽은 복원되지 않습니다.

<figure style="margin:1.5rem 0;"><a href="/images/face-enrollment/align.png" target="_blank" rel="noopener" style="border-bottom:none;"><img src="/images/face-enrollment/align.png" alt="5점 정렬 전후를 비교한 두 패널. 왼쪽 (a)는 기울어진 얼굴, 작게 찍힌 얼굴, 프레임 한쪽에 치우친 얼굴이 정렬 후 모두 같은 112×112 정면 얼굴이 되고 랜드마크 5점이 기준점과 겹친다. 오른쪽 (b)는 옆으로 돌린 얼굴과 위에서 내려다본 얼굴로, 정렬 후에도 옆얼굴과 눌린 얼굴이 남고 랜드마크가 기준점과 어긋난다" style="width:100%;margin:0;"></a><figcaption style="font-size:0.82rem;color:#666;margin-top:0.5rem;line-height:1.6;"><strong>5점 정렬(2D similarity transform)이 보정하는 변화와 보정하지 못하는 변화.</strong> (a) 위에서부터 roll, scale, translation. 모두 이미지 평면 안의 변화라 정렬 후 같은 정면 얼굴이 되고, 검출된 랜드마크 5점(●)이 기준점(+)과 일치합니다. (b) 위는 yaw 60°, 아래는 pitch 35°. 평면 밖의 회전이라 정렬은 랜드마크 5점을 기준점에 최대한 가깝게 맞출 뿐 일치시키지 못합니다. Yaw는 옆얼굴이 그대로 남고, pitch는 눈–입 세로 간격이 눌린 채 남습니다. 회전과 균일한 크기 조정만으로는 세로 방향만 늘릴 수 없기 때문입니다. 3D 모델: MakeHuman base mesh (CC0).</figcaption></figure>

모델 자체도 pose에 완전히 강건하지는 않습니다.
ArcFace류의 학습 데이터는 웹에서 수집한 in-the-wild 이미지라 여러 각도가 섞여 있지만, 대부분 정면에 치우쳐 있습니다 \[24\].

- CFP 데이터셋 논문은 당시 알고리즘들의 정확도가 정면-정면 대비 정면-측면에서 10%p 이상 떨어진다고 보고했습니다 \[4\].
- ArcFace 논문에서도 같은 모델이 LFW에서는 99.83%, pose 차이를 강조한 CPLFW에서는 92.08%를 기록했습니다 \[1\].
- Baltanas et al.은 yaw ±65°, pitch ±35° 범위를 고르게 담은 데이터셋으로 정면 1장 등록을 평가했습니다. 세 모델 모두 각도가 커질수록 본인 간 거리가 벌어졌고, ArcFace는 가장 큰 각도 구간에서 평균 거리가 threshold를 넘었습니다. 주요 벤치마크 점수가 가장 좋은 모델이 pose 강건성은 가장 낮았다는 점도 눈여겨볼 만합니다 \[24\].

즉 gallery와 probe의 각도 차이가 클수록 본인 간 유사도가 내려가고, 같은 threshold에서 본인 거절이 늘어납니다.
다각도 등록은 모델을 바꾸지 않고 이 각도 차이를 줄이는 방법입니다.
Probe가 어떤 각도로 들어와도 가까운 각도의 템플릿이 gallery에 하나는 있게 됩니다.

같은 연구에서 gallery를 1인당 1개 각도에서, 최적화로 고른 5개 각도로 늘리자 ArcFace의 식별 정확도가 0.73에서 약 0.95로 올랐습니다 \[24\].
다만 21명 규모의 데이터셋에서 각도 선택과 평가를 함께 한 결과라, 수치보다는 경향으로 읽는 것이 맞습니다.
같은 실험에서 확인된 경향은 세 가지입니다.

- **개선 폭은 체감합니다.** 처음 몇 장을 더할 때 효과가 가장 크고, 이후로는 장수를 늘려도 이득이 적습니다.
- **어떤 각도를 넣느냐가 중요합니다.** 인접한 각도는 정보가 겹치므로, 장수보다 각도의 분산이 효과를 좌우합니다.
- **타인과의 거리도 함께 줄어듭니다.** 1인당 템플릿이 늘면 타인 템플릿과 우연히 가까워질 기회도 늘어, 오인식 위험이 커집니다. 이 실험에서는 threshold와 거리가 충분히 멀었지만, 대규모 gallery에서는 FAR을 다시 측정해야 합니다.

효과의 크기는 probe 환경에 달려 있습니다.
걸어 지나가는 사람을 CCTV로 잡는 환경에서는 차이가 크고, 키오스크 앞에 서서 정면을 보는 환경에서는 작습니다.

### 질문 2. 잘 찍힌 사진 1장이면 충분하지 않은가

"잘 찍힌 1장"을 고를 수 있다는 가정이 약합니다. 여러 장이 필요한 이유는 세 가지입니다.

- **한 장의 임베딩에는 잡음이 있습니다.** 표정, 조명, 미세한 blur, 검출 박스의 흔들림이 벡터를 조금씩 움직입니다. 여러 장을 쓰면 이 분산이 줄어듭니다. IJB 계열 벤치마크가 한 사람을 이미지 여러 장의 묶음(template)으로 평가하고 \[5\], 묶음을 하나로 합치는 방법이 별도 연구 주제인 이유입니다 \[6\].
- **품질 점수는 완벽하지 않습니다.** FIQA가 높게 평가한 이미지가 실제 매칭에서도 가장 좋다는 보장은 없습니다. 한 장에 전부를 걸면 그 한 장이 나쁠 때 대안이 없습니다.
- **두 장 이상이어야 일관성 검사가 가능합니다.** 등록 중 다른 사람의 얼굴이 섞였는지는 프레임끼리 비교해야 알 수 있습니다.

상용 사례로는 Apple Face ID가 있습니다. 
등록 때 고개를 돌려 여러 각도를 캡처하게 하고, 이후 인증에 성공할 때마다 얼굴 데이터를 갱신합니다 \[7\].

### N장을 어떻게 쓸 것인가

| 방식 | 저장 | 점수 계산 | 장점 | 주의점 |
| --- | --- | --- | --- | --- |
| 전부 저장 + max | 사람당 N개 Vector | 템플릿별 유사도의 최댓값 | 각도 대응이 가장 좋음 | 저장·검색 비용 N배, 타인 수락률 상승 |
| 평균 centroid 1개 | 사람당 1개 Vector | centroid와의 유사도 | 저장·검색이 가장 가벼움 | 각도가 넓으면 평균이 어느 각도와도 멀어짐 |
| pose bucket별 centroid | 사람당 3\~5행 | bucket centroid 중 최댓값 | 잡음 감소와 각도 대응의 절충 | bucket 경계와 개수를 정해야 함 |

**max 방식에서 놓치기 쉬운 점**: 사람당 템플릿이 늘면 타인 얼굴이 그중 하나와 우연히 높은 점수를 낼 기회도 늘어납니다. 템플릿 수를 바꾸면 threshold를 다시 셋팅해야 합니다.

```python
import numpy as np

def l2n(x: np.ndarray) -> np.ndarray:
    return x / np.linalg.norm(x, axis=-1, keepdims=True)

def score_max(probe: np.ndarray, templates: np.ndarray) -> float:
    """templates: (K, 512), 모두 L2 정규화. 가장 가까운 템플릿의 유사도."""
    return float((templates @ probe).max())

def centroid(templates: np.ndarray) -> np.ndarray:
    """평균 후 반드시 다시 정규화한다."""
    return l2n(templates.mean(axis=0))

def bucket_centroids(templates: np.ndarray, buckets: list[str]) -> dict[str, np.ndarray]:
    out = {}
    for bucket in set(buckets):
        idx = [i for i, x in enumerate(buckets) if x == bucket]
        out[bucket] = centroid(templates[idx])
    return out
```

### 근거는 자기 데이터로 다시 확인한다

위 문헌은 방향을 알려 줄 뿐, 우리 카메라와 우리 회원에게 얼마나 효과가 있는지는 알려 주지 않습니다. 같은 probe 집합에 대해 gallery 구성만 바꿔 비교합니다.

1. 동일 인원에 대해 gallery를 세 가지로 만듭니다: 정면 1장, 정면 N장, 다각도 N장.
2. 미등록자 probe로 오식별률이 같아지도록 구성별 threshold를 맞춥니다.
3. 그 threshold에서 등록자 probe의 미식별률을 비교합니다.

threshold를 고정한 채 비교하면 템플릿 수가 많은 쪽이 유리하게 보이므로 2번 단계를 빼면 안 됩니다. 
시작점으로는 정면·좌·우·상·하 5개 bucket에 bucket당 1\~3장을 제안하지만, 이 숫자는 검증 대상이지 정답이 아닙니다.

## 3. 등록 프로토콜: staging 후 commit

다각도 N-shot 등록은 요청 여러 번에 걸쳐 진행되므로, 중간 상태가 gallery에 저장되지 않아야 합니다.
등록 중인 프레임은 staging에 쌓고, 조건을 모두 만족했을 때 한 트랜잭션으로 gallery에 옮깁니다.

### 절차

1. **세션 열기**: 서버가 동의 여부를 확인하고 세션을 만듭니다. 세션 토큰은 대상자와 기기에 묶이고 수 분 안에 만료되어야 합니다.
2. **프레임 제출**: 클라이언트가 프레임을 한 장씩 보냅니다. 서버는 검사를 통과한 임베딩만 staging에 넣고, 아직 채워지지 않은 각도를 응답으로 알려 줍니다.
3. **commit**: 필요한 각도가 모두 채워지면 gallery 내 중복을 검사한 뒤 한 트랜잭션으로 반영합니다.
4. **만료 정리**: commit되지 않고 만료된 세션의 staging 행은 주기 작업이 삭제합니다.

### 프레임마다 하는 검사

| 검사 | 거절 사유 | 막으려는 것 |
| --- | --- | --- |
| 캡쳐된 이미지에 얼굴이 정확히 하나 | `face_count` | 뒤에 선 사람이 함께 등록되는 것 |
| liveness | `liveness` | 사진·영상으로 타인을 등록하는 것 |
| 품질(FIQA) | `quality` | blur, 가림, 역광 이미지가 템플릿이 되는 것 |
| 세션 내 일관성 | `identity_mismatch` | 중간에 다른 사람으로 바뀌어 얼굴이 섞이는 것 |
| 근접 중복 | `near_duplicate` | 거의 같은 프레임 N장으로 각도 조건을 채우는 것 |

품질 검사는 임베딩 전에 합니다.
저품질 이미지의 임베딩은 위치가 불안정해 gallery 전체의 오식별을 늘립니다.
FIQA 방법으로는 SER-FIQ \[8\], MagFace의 norm \[2\] 등이 있고,
이미지 프로세싱 기법으로 두 눈 사이의 거리, blurness, 조도 등을 측정하는 방안이 있습니다.

일관성 threshold는 식별용 threshold보다 낮게 잡습니다.
정면과 측면처럼 각도가 다른 본인 프레임끼리는 유사도가 내려가기 때문입니다.
근접 중복은 클라이언트의 캡처 간격으로 먼저 줄이고, 서버가 같은 bucket 안에서 한 번 더 걸러 냅니다.

### 세션 보호

- 프레임 요청은 `subject_ref`를 받지 않습니다. 대상자는 세션 토큰에서만 결정됩니다.
- 세션당 프레임 시도 횟수와 대상자당 세션 생성 횟수에 상한을 둡니다.
- 원본 이미지는 메모리에서만 처리하고 디스크와 로그에 남기지 않습니다. staging에는 임베딩만 들어갑니다.
- 공용 기기에서 등록할 때는 감독자 계정의 인증을 세션 생성 조건으로 둡니다.

### 스키마

**`enrollment_staging`**: commit 전 임시 보관

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `staging_id` | `uuid` PK |  |
| `session_id` | `uuid` FK NOT NULL | 세션 삭제 시 함께 삭제(`ON DELETE CASCADE`) |
| `embedding` | `vector(512)` NOT NULL |  |
| `raw_norm` | `real` |  |
| `pose_bucket` | `text` NOT NULL |  |
| `yaw`, `pitch` | `real` |  |
| `quality_score` | `real` |  |
| `liveness_score` | `real` |  |
| `created_at` | `timestamptz` NOT NULL |  |

### 예시 코드

아래 코드는 흐름을 보여 주기 위한 것입니다. `detect_and_align`, `liveness_score`, `quality_score`, `embed`, `get_session`, `db`는 설명용 stub이며, threshold 값은 임의의 예시입니다. `to_template`과 `centroid`는 앞 장의 함수입니다.

```python
from contextlib import asynccontextmanager
from uuid import UUID

import asyncpg
import numpy as np
from fastapi import Depends, FastAPI, HTTPException, UploadFile
from pgvector.asyncpg import register_vector

T_LIVE, T_QUAL = 0.5, 0.6      # 예시 값. 자체 데이터로 정한다
T_SAME_MIN = 0.35              # 세션 centroid와의 최소 유사도
T_NEAR_DUP = 0.98              # 같은 bucket에서 이보다 비슷하면 정보가 없다
T_DUP = 0.60                   # gallery의 다른 사람과 이보다 비슷하면 보류
REQUIRED = {"front", "left", "right", "up", "down"}
MAX_FRAMES = 40

pool: asyncpg.Pool


@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool
    # 연결마다 vector <-> np.ndarray(float32) 코덱을 등록한다
    pool = await asyncpg.create_pool(DSN, init=register_vector)
    yield
    await pool.close()


app = FastAPI(lifespan=lifespan)


def pose_bucket(yaw: float, pitch: float) -> str:
    # 부호 규약은 Face Detector 좌표계를 따른다 (여기서는 yaw < 0 이 왼쪽, pitch > 0 이 위)
    if abs(yaw) <= 10 and abs(pitch) <= 10:
        return "front"
    if abs(yaw) >= abs(pitch):
        return "left" if yaw < 0 else "right"
    return "up" if pitch > 0 else "down"

# get_session: 인증과 세션 소유권만 확인한다. 
# 상태 판단은 DB에서 잠금과 함께 한다.
@app.post("/enroll/sessions/{session_id}/frames", dependencies=[Depends(get_session)])
async def add_frame(session_id: UUID, file: UploadFile):
    # 1) 시도 횟수를 원자적으로 차감한다. 실패한 프레임도 차감.
    async with pool.acquire() as conn:
        counted = await conn.fetchval(
            """
            UPDATE enrollment_sessions
               SET attempt_count = attempt_count + 1
             WHERE session_id = $1 AND status = 'open'
               AND expires_at > now() AND attempt_count < $2
            RETURNING attempt_count
            """,
            session_id, MAX_FRAMES,
        )
        if counted is None:
            row = await conn.fetchrow(
                "SELECT status, expires_at > now() AS alive "
                "FROM enrollment_sessions WHERE session_id = $1",
                session_id,
            )
            if row is None:
                raise HTTPException(404, "session not found")
            if row["status"] != "open" or not row["alive"]:
                raise HTTPException(409, "session closed")
            raise HTTPException(429, "too many frames")

    # 2) 무거운 추론은 잠금 밖에서. 이미지는 메모리에서만 처리한다.
    img = decode_image(await file.read())
    faces = detect_and_align(img)
    if len(faces) != 1:
        return {"accepted": False, "reason": "face_count"}
    face = faces[0]
    if liveness_score(img) < T_LIVE:
        return {"accepted": False, "reason": "liveness"}
    q = quality_score(face.aligned)
    if q < T_QUAL:
        return {"accepted": False, "reason": "quality"}

    v, norm = to_template(embed(face.aligned))
    bucket = pose_bucket(face.yaw, face.pitch)

    # 3) 세션 행을 잠그고 검사와 저장을 한 번에. commit과도 직렬화된다.
    async with pool.acquire() as conn, conn.transaction():
        alive = await conn.fetchval(
            "SELECT status = 'open' AND expires_at > now() "
            "FROM enrollment_sessions WHERE session_id = $1 FOR UPDATE",
            session_id,
        )
        if not alive:                          # 추론하는 사이 commit 되었거나 만료
            raise HTTPException(409, "session closed")

        staged = await conn.fetch(
            "SELECT embedding, pose_bucket FROM enrollment_staging WHERE session_id = $1",
            session_id,
        )
        if staged:
            embs = np.stack([r["embedding"] for r in staged])
            # 개별 프레임 최솟값 대신 centroid와 비교한다.
            # 좌우 측면끼리는 같은 사람이어도 유사도가 낮게 나올 수 있다.
            if float(centroid(embs) @ v) < T_SAME_MIN:
                return {"accepted": False, "reason": "identity_mismatch"}
            same = [float(e @ v) for e, r in zip(embs, staged) if r["pose_bucket"] == bucket]
            if same and max(same) > T_NEAR_DUP:
                return {"accepted": False, "reason": "near_duplicate"}

        await conn.execute(
            """
            INSERT INTO enrollment_staging
                (session_id, embedding, raw_norm, pose_bucket, yaw, pitch, quality_score)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            session_id, v, norm, bucket, face.yaw, face.pitch, q,
        )

    covered = {r["pose_bucket"] for r in staged} | {bucket}
    return {"accepted": True, "remaining": sorted(REQUIRED - covered)}


@app.post("/enroll/sessions/{session_id}/commit", dependencies=[Depends(get_session)])
async def commit(session_id: UUID):
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            """
            SELECT status, expires_at > now() AS alive, subject_ref, model_version
            FROM enrollment_sessions WHERE session_id = $1 FOR UPDATE
            """,
            session_id,
        )
        if row is None:
            raise HTTPException(404, "session not found")
        # 재시도에는 같은 결과를 돌려준다 (만료 여부보다 먼저 확인)
        if row["status"] == "committed":
            return {"status": "committed"}
        if row["status"] == "held":
            return {"status": "held_for_review"}
        if row["status"] != "open" or not row["alive"]:
            raise HTTPException(409, "session closed")

        subject_ref, model_version = row["subject_ref"], row["model_version"]

        staged = await conn.fetch(
            "SELECT embedding, pose_bucket FROM enrollment_staging WHERE session_id = $1",
            session_id,
        )
        if not REQUIRED <= {r["pose_bucket"] for r in staged}:
            raise HTTPException(422, "pose coverage incomplete")

        # gallery에 이미 같은 얼굴이 다른 사람으로 등록되어 있는지 확인.
        # HNSW는 WHERE를 인덱스 탐색 뒤에 적용하므로, 조건에 맞는 행이 모자라면
        # 탐색을 이어가도록 한다 (pgvector 0.8+).
        #
        # pgvector 없이 PostgreSQL만 쓴다면: 
        # 같은 조건의 템플릿을 커서로 배치 단위로 읽어
        # 애플리케이션에서 내적을 계산하고 최댓값만 유지한다 (전수 비교).
        # 등록 빈도가 낮으니 템플릿 수만 개까지는 충분하고, 그 이상이면
        # model_version별 gallery 행렬을 메모리에 캐시하거나 벡터 인덱스 사용.
        await conn.execute("SET LOCAL hnsw.iterative_scan = strict_order")
        c = centroid(np.stack([r["embedding"] for r in staged]))
        hit = await conn.fetchrow(
            """
            SELECT subject_ref, 1 - (embedding <=> $1) AS sim
            FROM face_templates
            WHERE status = 'active' AND model_version = $2 AND subject_ref <> $3
            ORDER BY embedding <=> $1
            LIMIT 1
            """,
            c, model_version, subject_ref,
        )
        if hit and hit["sim"] >= T_DUP:
            # staging은 검토용으로 남긴다
            await conn.execute(
                "UPDATE enrollment_sessions SET status = 'held' WHERE session_id = $1",
                session_id,
            )
            return {"status": "held_for_review"}

        # 기존 템플릿 교체, 신규 삽입, staging 삭제, 세션 종료를 한 트랜잭션으로
        await conn.execute(
            "UPDATE face_templates SET status = 'retired' "
            "WHERE subject_ref = $1 AND status = 'active'",
            subject_ref,
        )
        await conn.execute(
            """
            INSERT INTO face_templates
                (template_id, subject_ref, model_version, embedding, raw_norm,
                 pose_bucket, yaw, pitch, quality_score, session_id, status, created_at)
            SELECT gen_random_uuid(), $2, $3, embedding, raw_norm,
                   pose_bucket, yaw, pitch, quality_score, session_id, 'active', now()
            FROM enrollment_staging WHERE session_id = $1
            """,
            session_id, subject_ref, model_version,
        )
        await conn.execute("DELETE FROM enrollment_staging WHERE session_id = $1", session_id)
        await conn.execute(
            "UPDATE enrollment_sessions SET status = 'committed', committed_at = now() "
            "WHERE session_id = $1",
            session_id,
        )
    return {"status": "committed"}
```

`<=>`는 pgvector의 cosine distance 연산자입니다 \[3\].

### 중복과 유사인 처리

commit 시점의 gallery 검색 결과는 세 구간으로 나눕니다.

| 다른 사람과의 최고 유사도 | 해석 | 처리 |
| --- | --- | --- |
| 매우 높음 | 같은 사람이 다른 계정으로 등록했거나 쌍둥이 | 자동 거절하지 않고 보류 후 사람이 확인 |
| 식별 threshold 근처 | 닮은 사람이 gallery에 있음 | 등록은 진행하고 두 사람을 유사인 쌍으로 표시 |
| 낮음 | 문제 없음 | 그대로 commit |

유사인 쌍으로 표시된 사람은 식별 때 추가 확인을 거치게 할 수 있습니다.
토스 페이스페이는 닮은 얼굴이 있는 사용자에게 얼굴 인식 후 휴대폰 뒷자리 입력 같은 2차 인증을 요구한다고 밝혔습니다 \[12\].

`retired` 상태는 재등록 직후 문제가 생겼을 때 되돌리기 위한 짧은 유예용입니다.
유예 기간이 지나면 주기 작업이 실제로 삭제합니다. 쓰지 않는 템플릿을 무기한 보관할 근거는 없습니다.

## 4. 검색과 판정

Gallery를 잘 만들어도 판정 규칙이 느슨하면 미등록자가 누군가로 식별됩니다.
1:N 서비스에서는 "가장 비슷한 사람을 찾는 것"보다 "gallery에 없는 사람을 없다고 답하는 것"이 더 어렵고 더 중요합니다.
토스도 미등록자가 등록자 중 한 명으로 인식되면 결제 사고로 이어진다는 점을 강조합니다 \[12\].

### 판정 규칙

템플릿 단위 점수를 사람 단위로 모은 뒤 두 조건을 봅니다.

- **절대 기준**: 1위의 점수가 threshold 이상인가.
- **상대 기준**: 1위와 2위 사람의 점수 차이가 충분한가. 차이가 작으면 닮은 두 사람 사이에서 헷갈리고 있다는 뜻입니다.

```python
import numpy as np
from typing import Literal

IdStatus = Literal["match", "ambiguous", "no_match"]

def identify(
    probe: np.ndarray,
    gallery: np.ndarray,
    subject_refs: list[str],
    t_accept: float,
    t_margin: float,
) -> tuple[str | None, IdStatus]:
    """gallery: (M, 512) 정규화 템플릿, subject_refs: 길이 M"""
    sims = gallery @ probe
    best_score_by_subject: dict[str, float] = {}
    for subject, sim in zip(subject_refs, sims):
        # 사람 단위 max
        best_score_by_subject[subject] = max(
            best_score_by_subject.get(subject, -1.0),
            float(sim)
        )
    ranked = sorted(
        best_score_by_subject.items(), 
        key=lambda kv: -kv[1]
    )
    top_subject, top_score = ranked[0]

    if len(ranked) > 1:
        runner_up_score = ranked[1][1]
    else:
        runner_up_score = -1.0

    if top_score < t_accept:
        return None, "no_match"
    if top_score - runner_up_score < t_margin:
        # 2차 확인으로 넘긴다
        return top_subject, "ambiguous"
    return top_subject, "match"
```

같은 일을 DB에서 하면 다음과 같습니다. 벡터 인덱스가 없으면 pgvector는 전수 비교(exact search)를 합니다 \[3\].

```sql
SELECT subject_ref, max(1 - (embedding <=> $1)) AS score
FROM face_templates
WHERE status = 'active' AND model_version = $2
GROUP BY subject_ref
ORDER BY score DESC
LIMIT 2;
```
### threshold는 gallery 크기와 함께 정한다

모델 카드에서 흔히 보는 "FAR(False Accept Rate) 0.001%"는 **얼굴 두 개를 한 번 비교했을 때** 다른 사람을 같은 사람으로 잘못 판정할 확률입니다. 
서로 다른 두 사람의 얼굴을 10만 번 비교하면 그중 1번 정도는 우연히 threshold를 넘는다는 뜻입니다.

> 엄밀히 말하면 비교 한 번 단위의 이 수치는 FMR(False Match Rate)이고, FAR은 재시도 정책 등을 포함한 시스템 수준의 수치입니다. 모델 카드의 FAR은 대부분 FMR을 뜻하므로 이 글에서는 FMR로 통일합니다.

이 값은 모델의 고정된 성능이 아니라 **threshold에 따라 달라지는 값**입니다. 
threshold를 올리면 FMR은 내려가지만, 대신 본인을 거절하는 비율이 올라갑니다.

#### 1:1 인증과 1:N 식별은 다르다
![](/images/face-enrollment/fmr-vs-fpir.png)

1:1 인증은 "당신이 A가 맞습니까?"라는 질문입니다. A의 템플릿과 한 번만 비교하므로, 다른 사람이 A로 통과할 확률은 FMR 그대로입니다.

1:N 식별은 "당신은 누구입니까?"라는 질문입니다. gallery의 N명 모두와 비교해서 threshold를 넘는 사람이 있는지 찾습니다. 이때 gallery에 없는 사람이 검색했는데 누군가와 잘못 매칭되는 비율을 **FPIR**(False Positive Identification Rate)이라고 합니다. FMR이 비교 한 번의 오류율이라면, FPIR은 검색 한 번의 오류율입니다.

#### 비교 한 번은 복권 한 장이다

비교 한 번을 당첨 확률 10만분의 1짜리 복권 한 장이라고 생각해 보겠습니다. 여기서 당첨은 오매칭(False Match)입니다. 1:1 인증은 복권을 한 장 사는 것이고, gallery가 1만 명인 1:N 검색은 한 번에 복권을 1만 장 사는 것입니다. 한 장의 당첨 확률은 낮아도 1만 장 중 하나라도 당첨될 확률은 무시할 수 없습니다.

NIST는 이 관계를 다음 식으로 설명합니다 [9].

$$
\mathrm{FPIR}(N) = 1 - (1 - \mathrm{FMR})^N \approx N \cdot \mathrm{FMR}
$$

비교 한 번에서 오매칭이 안 날 확률은 1 − FMR입니다. 
각 비교가 서로 독립이라고 가정하면, 
N번 모두 안 날 확률은 $(1 − FMR)^N$입니다.
1에서 이 값을 빼면 하나라도 오매칭이 날 확률이 됩니다. 
N과 FMR이 작을 때는 대략 N·FMR과 같으므로 **FPIR은 gallery 크기에 거의 비례한다**고 기억하면 됩니다.

FMR이 0.001%(1e-5)인 threshold를 그대로 쓰면 gallery 크기에 따라 FPIR은 다음과 같습니다.

| gallery 크기 | FPIR |
|---|---|
| 100명 | 약 0.1% |
| 1,000명 | 약 1% |
| 10,000명 | 약 9.5% |
| 100,000명 | 약 63% |

1:1 비교에서는 10만 번에 한 번 틀리던 threshold가, gallery 1만 명에서는 미등록자 열 명 중 한 명을 다른 사람으로 잘못 식별합니다.

#### 목표 FPIR에서 거꾸로 계산한다

따라서 threshold는 모델 카드의 수치를 그대로 쓰지 않고, 운영에서 허용할 FPIR을 먼저 정한 뒤 필요한 FMR을 거꾸로 계산해 정합니다.

$$
\mathrm{FMR} \approx \frac{\text{목표 FPIR}}{N}
$$

예를 들어 gallery 1만 명에서 FPIR을 1%로 유지하려면 FMR이 1e-6인 threshold가 필요합니다.
모델 카드 기준보다 열 배 엄격한 값이고, 그만큼 본인 거절도 늘어납니다.
이 트레이드오프를 받아들일지는 운영 판단이며, gallery가 커질 때마다 threshold를 다시 점검해야 하는 이유이기도 합니다.

```python
def fpir_from_fmr(fmr: float, n: int) -> float:
    return 1 - (1 - fmr) ** n

def threshold_for_fpir(nonmated_top1: np.ndarray, target_fpir: float) -> float:
    """nonmated_top1: 미등록자 probe 각각의 top-1 점수"""
    return float(np.quantile(nonmated_top1, 1 - target_fpir))

print(fpir_from_fmr(1e-5, 1_000))    # 0.00995...
print(fpir_from_fmr(1e-5, 10_000))   # 0.0951...
```

#### 비교 대상(N)을 줄이는 방법

threshold를 올리는 대신 비교 대상(N) 자체를 줄이는 방법도 있습니다.
직원 1만 명인 회사의 출입 시스템에서 연구실처럼 관련 임직원만 들어갈 수 있는 구역이라면,
그 구역의 단말기는 gallery 전체가 아니라 출입 권한이 있는 사람과만 비교하면 됩니다.
권한자가 500명이면 모델 카드 기준의 threshold를 그대로 써도 FPIR은 약 9.5%에서 약 0.5%로 내려갑니다.

#### 주의할 점

이 식은 모든 비교가 서로 독립이라는 가정 위에 있습니다. 
실제로는 유난히 닮은 사람들이 있고, 인구 집단에 따라 점수 분포도 다릅니다. 
따라서 이 식은 경향을 이해하는 도구로 쓰고, 실제 threshold는 자체 데이터로 측정해서 정해야 합니다.

더군다나 사람당 템플릿을 K개 저장하면 비교 횟수는 N×K로 늘어납니다. 
다만 같은 사람의 템플릿끼리는 서로 비슷해서, 한 템플릿이 미등록자와 우연히 닮았다면 나머지도 함께 닮았을 가능성이 큽니다.
그래서 FPIR이 K배까지 늘지는 않습니다.
N×K는 상한으로 보고, 실제 증가폭은 운영과 같은 방식(사람 단위로 최고 점수를 취하는 방식)으로 직접 측정하는 것이 정확합니다.

### Vector DB와 ANN은 언제 필요한가

Vector DB는 벡터를 저장하고, 주어진 벡터와 가까운 벡터를 빠르게 찾아 주는 저장소입니다.
임베딩 검색 시스템을 만든다고 하면 Vector DB부터 떠올리는 경우가 많지만, 먼저 구분해야 할 것이 있습니다.
Vector DB의 빠른 검색은 대부분 HNSW [10] 같은 ANN(**approximate** nearest neighbor) 인덱스에서 나오고, ANN은 속도의 대가로 "가장 가까운 벡터를 항상 찾는다"는 보장을 포기합니다.
그렇다고 Vector DB가 HNSW와 같은 ANN 인덱스만 지원하는 것은 아닙니다.
대부분의 Vector DB와 pgvector는 인덱스 없이 전수 비교하는 exact search도 지원합니다.
트레이드오프는 Vector DB가 아니라 ANN 인덱스에서 생깁니다.

#### ANN이 판정에 미치는 영향

HNSW는 파라미터를 적절히 잡으면 recall이 높게 나오고, 등록된 본인은 보통 타인보다 점수가 뚜렷하게 높아 잘 찾아집니다.
문제는 놓치는 경우가 점수가 비슷한 후보가 몰린 threshold 경계 근처에 집중된다는 점입니다.

- 본인의 템플릿을 놓치면 남은 후보는 대개 threshold 아래이므로 `no_match`가 됩니다. 본인 거절이 늘어납니다.
- 드물게는 본인 대신 threshold를 넘는 닮은 사람이 1위로 올라와, 다른 사람으로 식별됩니다.
- 2위를 놓치면 1위와의 점수 차가 실제보다 크게 계산되어, `ambiguous`로 걸러야 할 경우가 `match`로 통과합니다.
- 메타데이터 필터와 함께 쓰면 결과가 더 줄어듭니다. pgvector의 근사 인덱스는 인덱스를 탐색한 뒤에 `WHERE` 조건을 적용하기 때문입니다 [3]. pgvector 0.8 이상에서는 iterative scan으로 완화할 수 있습니다.

이런 오류는 로그에 흔적을 남기지 않고 인덱스 파라미터에 따라 달라지기 때문에, 문제가 생겼을 때 원인을 추적하기 어렵습니다.

재등록 시 기존 템플릿을 `retired`로 남기는 설계라면 한 가지를 더 주의해야 합니다. 시간이 지날수록 인덱스 안에 검색 대상이 아닌 행이 쌓여 필터 문제가 점점 심해집니다. ANN 인덱스는 처음부터 `WHERE status = 'active'` 조건의 partial index로 만드는 것이 좋습니다.

#### exact search로 충분한 규모는 생각보다 크다

512차원 float32 템플릿 10만 개는 약 205MB이고, 전수 비교는 행렬 곱 한 번입니다.
gallery가 애플리케이션 메모리에 올라와 있다면 일반적인 서버 CPU에서 수십 ms 안에 끝나는 규모입니다(대략적인 추정이므로 실제 환경에서 측정해야 합니다).
요청마다 DB에서 템플릿을 전부 읽어 오면 이보다 훨씬 느리므로, gallery는 model_version별로 메모리에 캐시하는 방안을 고려하고 등록이 commit될 때 갱신합니다.

| 상황 | 권장 |
| --- | --- |
| 템플릿 수십만 개 이하 | exact search. gallery를 메모리에 캐시 고려. ANN 인덱스는 만들지 않는다 |
| 그 이상이고 지연 시간 예산을 넘는다 | ANN으로 후보 top-k를 넉넉하게 뽑고, 후보들의 템플릿 전체로 점수를 다시 정확히 계산한다 |
| 지점·조직 단위로 검색 범위가 나뉜다 | 범위 컬럼으로 대상을 좁힌 뒤 exact search. ANN을 쓴다면 범위별 partial index로 필터 문제를 피한다 |
| 임베딩을 애플리케이션 레벨에서 암호화한다 | DB 인덱스를 쓸 수 없다. 복호화 후 메모리에서 exact search |

ANN의 재계산 단계는 후보 안에서의 순위와 margin을 바로잡을 뿐, ANN이 놓친 본인을 되살리지는 못합니다. top-k를 넉넉하게 잡아야 하는 이유입니다.

ANN을 도입한다면 배포 전과 운영 중에 주기적으로 exact search와 비교합니다. 이때 recall@k보다 같은 probe 세트에 대한 최종 판정(`match`, `ambiguous`, `no_match`)의 일치율을 보는 것이 실용적입니다. 인덱스 파라미터 변경이 운영 결과에 미치는 영향을 바로 알 수 있기 때문입니다.

#### 처음에는 기존 DB로 시작한다

exact search만 쓸 거라면 별도 Vector DB를 처음부터 도입할 이유가 적습니다. 오히려 비용이 먼저 생깁니다. 등록 commit은 기존 템플릿 retire, 신규 삽입, staging 삭제, 세션 종료를 트랜잭션 하나로 묶어야 하는데, 템플릿만 다른 저장소에 두면 이 원자성이 깨지고 한쪽만 반영된 상황을 직접 처리해야 합니다. 생체정보를 보관하는 저장소가 늘어나는 만큼 백업, 접근 통제, 감사 관리의 부담도 커집니다.

그래서 PostgreSQL + pgvector로 시작하는 것을 권합니다. 인덱스가 없으면 exact search로 동작하고, 템플릿과 세션이 같은 트랜잭션 안에 있으며, 규모가 커지면 같은 테이블에 HNSW partial index를 추가하는 것으로 ANN으로 넘어갈 수 있습니다. 별도 Vector DB는 템플릿이 수백만 개 이상이라 서버 한 대의 메모리에 담기 어렵거나 검색 QPS가 높아 수평 확장이 필요할 때 검토합니다. 그때도 등록 상태와 원본 템플릿은 PostgreSQL에 두고, Vector DB는 검색 전용 사본으로 동기화하는 구조가 안전합니다.

#### exact search로 충분한 규모는 생각보다 크다

512차원 float32 템플릿 10만 개는 약 205MB이고, 전수 비교는 행렬 곱 한 번입니다. 일반적인 서버 CPU에서 수십 ms 안에 끝나는 규모입니다(대략적인 추정이므로 실제 환경에서 측정해야 합니다).

| 상황 | 권장 |
| --- | --- |
| 템플릿 수십만 개 이하 | exact search. 인덱스를 만들지 않는다 |
| 그 이상이고 지연 시간 예산을 넘는다 | ANN으로 후보 top-k를 뽑고, 후보들의 템플릿 전체로 점수를 다시 정확히 계산한다 |
| 지점·조직 단위로 검색 범위가 나뉜다 | 범위별 exact search. 파티션이나 partial index를 활용한다 |
| 임베딩을 애플리케이션 레벨에서 암호화한다 | DB 인덱스를 쓸 수 없다. 복호화 후 메모리에서 exact search |

ANN을 도입한다면 exact search 결과와 비교한 recall을 배포 전에 측정하고, 운영 중에도 주기적으로 다시 측정합니다.

## 5. 악의적 등록과 제시 공격

공격 지점은 등록과 식별 두 곳이고, 등록 쪽이 더 위험합니다. 식별 단계의 공격은 한 번의 오수락으로 끝나지만, 잘못 등록된 템플릿은 삭제될 때까지 계속 통과합니다.

### 공격 유형

| 유형 | 예 | 대응 |
| --- | --- | --- |
| 제시 공격(presentation attack) | 카메라 앞에 사진, 영상, 마스크를 댐 | liveness(PAD) 모델. 평가 기준은 ISO/IEC 30107-3 \[11\] |
| 주입 공격(injection attack) | 가상 카메라나 조작된 API 요청으로 이미지를 직접 보냄 | 세션 nonce, 클라이언트 무결성 확인, 서버 측 재검증 |
| 타인 명의 등록 | 본인 얼굴을 다른 회원 계정에 등록 | 등록 전 본인 확인, 감독자 입회, 중복 검사(3장) |

liveness 모델은 카메라 앞의 위조만 막습니다. 카메라를 거치지 않는 주입 공격은 모델이 아니라 프로토콜로 막아야 합니다. 등록 프레임을 세션 토큰에 묶은 이유가 여기에 있습니다.

### 등록은 식별보다 엄격하게

- 등록 세션은 이미 인증된 계정에서만 열 수 있게 합니다. 얼굴 등록이 계정 인증을 대신하면 안 됩니다.
- liveness threshold를 식별 때보다 높게 둡니다. 등록은 한 번이므로 재시도 비용을 감수할 수 있습니다.
- 공용 기기 등록에는 감독자 계정을 기록합니다.

### Rate limit과 사후 대응

정상 사용자를 막지 않으면서 반복 시도를 느리게 만드는 것이 목표입니다. 
차단보다 지연, 기록, 대체 수단 유도를 기본으로 둡니다.

| 대상 | 정책 예시 | 초과 시 |
| --- | --- | --- |
| 기기당 식별 실패 | 짧은 시간 내 연속 실패 횟수 상한 | 대체 인증 수단으로 유도, 지연 추가 |
| 대상자당 등록 세션 | 하루 생성 횟수 상한 | 관리자 확인 후 재개 |
| 세션당 프레임 | 총 시도 횟수 상한 | 세션 종료 |
| 기기당 liveness 실패율 | 평소 대비 급증 감지 | 알림 후 조사 |

Apple Face ID도 얼굴 매칭이 5회 실패하면 passcode를 요구합니다 \[7\]. 
얼굴 인식이 유일한 수단이 아니어야 rate limit을 걸 수 있다는 점이 중요합니다.

```python
import time
from collections import defaultdict, deque
from fastapi import HTTPException

_failures: dict[str, deque] = defaultdict(deque)   # 예시용 in-memory 저장

def check_failure_budget(device_id: str, limit: int = 5, window_s: int = 60) -> None:
    q, now = _failures[device_id], time.monotonic()
    while q and now - q[0] > window_s:
        q.popleft()
    if len(q) >= limit:
        # 차단이 아니라 대체 수단으로 안내한다
        raise HTTPException(429, detail={"fallback": "use_alternative_auth"})

def record_failure(device_id: str) -> None:
    _failures[device_id].append(time.monotonic())
```

## 6. 템플릿 보호

"원본 이미지가 아니라 벡터만 저장하니 안전하다"는 성립하지 않습니다.
임베딩에서 얼굴 이미지를 복원할 수 있고, 얼굴은 비밀번호와 달리 유출되어도 바꿀 수 없습니다.
같은 모델로 다시 등록하면 거의 같은 임베딩이 나오기 때문입니다.

### 임베딩이 유출되면 무엇이 가능한가

- **얼굴 복원**: Mai et al.은 대상 모델의 내부 구조와 대상 인물에 대한 사전 지식 없이(모델은 블랙박스로만 사용) 템플릿에서 얼굴을 복원했습니다. 복원 이미지를 템플릿의 원본 이미지와 비교했을 때 LFW에서 FAR 0.1% 기준 95.20%가 같은 사람으로 판정됐습니다. 같은 사람의 다른 이미지와 비교하면 성공률은 크게 낮아집니다 \[13\].
- **다른 시스템으로의 전이**: Shahreza와 Marcel은 복원한 얼굴이 다른 특징 추출 모델을 쓰는 인식 시스템에도 통한다는 것을 보였습니다 \[14\].
- **연결**: 같은 모델을 쓰는 두 DB가 유출되면 임베딩만으로 동일인을 이어 붙일 수 있습니다. 모델이 달라도 복원 이미지를 거치면 연결이 가능합니다.

현실적인 피해 대상은 2D 이미지로 판정하는 서버 측 인식 시스템입니다.
깊이 정보를 요구하고 템플릿을 기기 안에만 두는 방식(예: Face ID \[7\])에는 복원한 2D 이미지가 그대로 통하지 않습니다.

ISO/IEC 24745는 생체 템플릿 보호 요건으로 비가역성(irreversibility), 연결 불가능성(unlinkability), 갱신 가능성(renewability)을 듭니다 \[15\].
평문 임베딩은 셋 다 만족하지 못합니다.

### 보호 수단: 누가 복호화하는가

암호화 수단은 "무엇을 암호화하는가"보다 "누가 복호화하는가"로 구분해야 차이가 보입니다.

- **저장소 암호화**: 디스크에 쓰이는 데이터를 스토리지나 DB 엔진이 암호화합니다. 디스크·볼륨 암호화와 DB의 TDE(Transparent Data Encryption)가 여기에 속합니다. 정상적인 DB 계정으로 조회하면 DB 엔진이 자동으로 복호화해 평문을 돌려줍니다. 그래서 디스크 탈취나 백업 매체 유출은 막지만, DB 계정 탈취나 DB 계정으로 받은 dump는 막지 못합니다.
- **가명화 분리**: 임베딩과 사용자 식별자를 다른 테이블이나 저장소에 나눠 두고, 둘을 잇는 매핑을 별도로 관리합니다. 벡터만 유출됐을 때 식별자와 바로 연결되는 것을 막습니다. 다만 얼굴 복원을 거친 재식별은 막지 못합니다.
- **애플리케이션 레벨 암호화**: 애플리케이션이 임베딩을 암호화한 뒤 DB에 넣습니다. DB는 처음부터 암호문만 받고, 복호화는 애플리케이션만 할 수 있습니다. 키는 보통 envelope 방식으로 관리합니다. 데이터는 데이터 키(DEK)로 암호화하고, DEK는 KMS에 있는 마스터 키로 다시 암호화해 암호문 옆에 저장합니다. 마스터 키는 KMS 밖으로 나오지 않습니다.
- **암호화 상태 매칭**: 동형암호 등을 써서 암호문끼리 바로 유사도를 계산합니다. 복호화 키를 서버 밖(클라이언트나 별도 키 서버)에 두면 서버도 평문을 보지 못합니다.

### 어떻게 조합하는가

이 수단들은 하나를 고르는 것이 아니라 층으로 쌓습니다.
저장소 암호화와 가명화 분리는 기본으로 깔고, 그 위에 무엇을 더할지를 고릅니다.

| | A. 저장소 암호화 + 가명화 분리 | B. A + 애플리케이션 레벨 암호화 | C. 암호화 상태 매칭 |
| --- | --- | --- | --- |
| 디스크·백업 매체 유출 | 막음 | 막음 | 막음 |
| DB dump·DB 계정 탈취 | 평문 벡터 노출 (식별자와는 분리) | 암호문만 노출 | 암호문만 노출 |
| 애플리케이션 서버 침해 | 노출 (app의 DB 계정으로 조회) | 노출 (app의 KMS 권한으로 복호화) | 복호화 키가 서버 밖에 있다면 막음 |
| 평문이 머무는 곳 | DB 서버 | 애플리케이션 메모리 | 키 보유처 외에는 없음 |
| 유사도 검색 위치 | DB 안. 인덱스·ANN 그대로 사용 | 애플리케이션 메모리. 기동 시 전체 복호화, commit 시 캐시 갱신 | 암호문 상태. 연산 비용이 크고 ANN 적용이 제한적 |
| 운영 부담 | 낮음 | 중간. 키 관리, 메모리 평문의 core dump·swap 차단 | 높음. 구현·검증 부담 |

A와 B의 차이는 DB만 유출됐을 때 드러납니다.
DB에 접근하는 경로와 사람은 애플리케이션 서버보다 훨씬 많으므로, 이 차이가 B를 더할 이유가 됩니다.
B에서는 DB가 암호문만 가지므로 유사도 계산을 DB 안에서 할 수 없고, 애플리케이션이 복호화한 벡터를 메모리에 올려 검색합니다.
처음부터 검색을 애플리케이션 메모리에서 하던 구성이라면, 복호화가 기동과 commit 시점에만 일어나므로 검색 비용은 늘지 않습니다.

애플리케이션 서버 침해는 A와 B 모두 막지 못하고, C만이 키를 서버 밖에 둘 때 막을 수 있습니다.
암호화한 채로 비교하는 방식은 연구가 진행 중이고 \[16\], 토스처럼 벡터를 암호화한 상태로 비교한다고 밝힌 상용 사례도 있습니다 \[12\].
다만 직접 구현하기에는 연산 비용과 검증 부담이 큽니다.

### 기본 구성 제안

- A(저장소 암호화 + 가명화 분리)는 항상 적용합니다.
- 검색을 애플리케이션 메모리에서 처리할 수 있다면 B(애플리케이션 레벨 암호화)를 더합니다.
- C는 외부 솔루션을 도입하는 경우가 아니라면 현재로서는 직접 구현을 권하지 않습니다.
- 애플리케이션 서버 침해처럼 막지 못하는 위험은 rate limit, audit 로그, 이상 탐지로 관리합니다.
- 사고 대응은 무엇이 유출됐는지에 따라 다릅니다. 암호문만 유출됐다면 키를 폐기하고 교체하면 됩니다. 평문 임베딩이 유출됐다면 같은 모델로 재등록해도 갱신이 되지 않으므로, 모델 교체나 cancelable 변환을 거친 재등록이 필요합니다.

### 법적 요건

국내에서는 생체인식정보를 저장할 때 암호화하는 것이 고시상 의무입니다 \[19\].
암호화 여부는 선택 사항이 아닙니다.
다만 저장소 암호화만으로 요건을 충족하는지, 애플리케이션 레벨 암호화까지 필요한지는 법무 검토로 확인해야 합니다.

### 가명화 분리

`face_templates`에는 회원 ID 대신 `subject_ref`만 둡니다. 둘을 잇는 표는 별도 스키마나 별도 DB에 두고 접근 권한을 분리합니다.

**`subject_links`**: 가명 키와 회원의 연결

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `subject_ref` | `uuid` PK | gallery에서 쓰는 가명 키 |
| `person_id_enc` | `bytea` NOT NULL | 암호화한 회원 ID |
| `wrapped_dek` | `bytea` | 이 사람의 템플릿용 데이터 키(키 관리 서비스가 감싼 값) |
| `created_at` | `timestamptz` NOT NULL |  |

### Envelope 암호화

사람마다 데이터 키(DEK)를 만들어 템플릿을 암호화하고, DEK는 외부 키 관리 서비스의 키(KEK)로 감싸 저장합니다.
키 관리 서비스의 종류는 무엇이든 상관없고, 감싸기와 풀기 두 연산만 있으면 됩니다.

```python
import os
from uuid import UUID
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

class KeyManager:
    """설명용 인터페이스. 실제로는 외부 키 관리 서비스 호출."""
    def wrap(self, dek: bytes) -> bytes: ...
    def unwrap(self, wrapped: bytes) -> bytes: ...

def new_subject_key(km: KeyManager) -> tuple[bytes, bytes]:
    dek = AESGCM.generate_key(bit_length=256)
    return dek, km.wrap(dek)                 # wrapped 값만 DB에 저장

def encrypt_template(v, subject_ref: UUID, dek: bytes) -> dict:
    nonce = os.urandom(12)
    # subject_ref를 AAD로 묶어 다른 사람 행으로 바꿔치기하는 것을 막는다
    ct = AESGCM(dek).encrypt(nonce, to_bytes(v), subject_ref.bytes)
    return {"nonce": nonce, "ciphertext": ct}

def decrypt_template(row: dict, subject_ref: UUID, dek: bytes):
    return from_bytes(AESGCM(dek).decrypt(row["nonce"], row["ciphertext"], subject_ref.bytes))
```

사람 단위 DEK의 부가 효과는 삭제입니다.
`wrapped_dek`을 지우면 백업에 남은 그 사람의 암호문도 읽을 수 없게 됩니다(crypto-shredding).

### 메모리

복호화한 gallery와 처리 중인 이미지는 서비스 프로세스 메모리에 존재합니다. 
Python에서 메모리를 확실히 지우는 것은 어렵기 때문에 노출 경로를 줄이는 쪽으로 접근합니다.

- core dump와 swap을 끕니다.
- 메모리 내용을 내보내는 디버그 엔드포인트와 프로파일러를 운영 환경에서 제거합니다.
- 원본 이미지는 임베딩 직후 참조를 버리고, 임시 파일로 쓰지 않습니다.
- 식별 서비스를 다른 기능과 분리된 프로세스로 띄워 접근 주체를 줄입니다.

### API

- **유사도 점수를 응답에 넣지 않습니다.** 점수를 돌려주면 입력을 조금씩 바꿔 가며 점수를 올리는 방식으로 템플릿을 역추정할 수 있습니다. 클라이언트에는 결과 코드만 줍니다.
- **실패 사유를 구분하지 않습니다.** "미등록"과 "threshold 미달"을 다르게 응답하면 특정인의 등록 여부가 새어 나갑니다.
- **응답 시간을 맞춥니다.** 조기 종료 경로와 전체 경로의 시간 차이가 크면 같은 정보가 시간으로 새어 나갑니다. 최소 응답 시간을 두는 정도로 충분합니다.
- 등록 보류 응답도 "다른 계정에 같은 얼굴이 있다"는 사실을 드러내지 않게 일반적인 문구로 돌려줍니다.

### 로깅

애플리케이션 로그는 여러 시스템으로 흘러가고 접근 범위가 넓습니다. `person_id 123 face enrollment finished at 14:02:11` 같은 로그는 그 자체로 "누가 언제 얼굴을 등록했다"는 개인정보입니다.

| 구분 | 남기는 것 | 남기지 않는 것 |
| --- | --- | --- |
| 애플리케이션 로그 | `event_id`, 결과 코드, 처리 시간, 모델 버전 | 벡터, 이미지, 회원 ID, 유사도 점수 |
| Audit 로그(접근 통제된 별도 저장소) | 행위자(직원·기기), 행위(등록·commit·삭제·조회), 시각, `subject_ref`, `consent_id` | 벡터, 이미지 |

Audit 로그는 보존 기간을 정하고 그 뒤에는 삭제합니다. 공용 기기에서 이루어진 등록은 로그인된 감독자 계정을 함께 기록합니다.

## 7. 법적 절차: 동의, 파기, 대체 수단

얼굴 템플릿은 개인정보 보호법상 민감정보이므로 일반 개인정보와 구분된 별도 동의가 필요합니다 \[17\]\[18\]. 이 장은 국내 법령을 설계에 어떻게 반영할지 정리한 것이며 법률 자문이 아닙니다. 조문과 고시는 개정되므로 현행본과 법무 검토로 확인해야 합니다.

### 요구 사항과 설계 반영

개인정보보호위원회의 생체정보 보호 가이드라인은 인증·식별 목적의 생체인식정보를 원본정보(촬영한 얼굴 이미지)와 특징정보(임베딩)로 나누고, 특징정보를 민감정보로 봅니다 \[18\].

| 요구 | 설계 반영 |
| --- | --- |
| 민감정보 처리에 대한 별도 동의 | `consent_id` 없이는 등록 세션을 만들 수 없게 스키마로 강제 |
| 원본정보는 특징정보 생성 후 파기가 원칙 | 이미지는 메모리에서만 처리, 저장소와 로그에 남기지 않음 |
| 생체인식정보 암호화 저장 \[19\] | 6장의 저장소 암호화와 envelope 암호화 |
| 생체인식을 원치 않는 사람을 위한 대체 수단 | 얼굴 등록 없이도 같은 서비스를 쓸 수 있는 경로 제공 |
| 목적 달성, 보유 기간 만료, 동의 철회 시 파기 | 아래 삭제 절차 |

규모가 크거나 새로운 방식이라면 개인정보보호위원회의 사전적정성 검토를 받는 방법도 있습니다.
토스 페이스페이가 이 절차를 거쳤다고 밝혔습니다 \[22\].

### 동의 기록

"동의했다"는 사실만이 아니라 "어떤 문구에 동의했는지"를 증빙할 수 있어야 합니다.

**`consents`**: 동의 이력

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `consent_id` | `uuid` PK |  |
| `person_id` | `uuid` NOT NULL |  |
| `consent_type` | `text` NOT NULL | 예: `biometric_template` |
| `consent_version` | `text` NOT NULL | 동의서 버전 |
| `document_hash` | `text` NOT NULL | 동의서 본문의 해시. 본문은 버전별로 별도 보관 |
| `method` | `text` NOT NULL | `app` / `kiosk` / `paper` |
| `agreed_at` | `timestamptz` NOT NULL |  |
| `retention_until` | `timestamptz` | 동의서에 적은 보유 기간의 끝 |
| `withdrawn_at` | `timestamptz` NULL | 철회 시각 |

철회 시각을 기록하는 것 외에는 행을 수정하지 않고 추가만 합니다. 동의서의 목적이나 보유 기간이 바뀌면 새 버전으로 다시 동의를 받고, `consent_version`으로 재동의 대상자를 찾습니다.

### 삭제 절차

탈퇴, 동의 철회, 보유 기간 만료는 모두 같은 절차로 처리합니다.
여기서는 기본 흐름만 보고, 저장 위치별 폐기 방법과 검증은 8장에서 다룹니다.

1. `consents.withdrawn_at`을 기록합니다.
2. 한 트랜잭션으로 해당 `subject_ref`의 `face_templates`, `enrollment_staging`, 진행 중인 세션, `subject_links` 행을 삭제합니다.
3. 서비스 메모리에 올라가 있는 gallery 캐시에서 제거합니다. DB만 지우고 이 단계를 빠뜨리면 삭제된 사람이 계속 식별됩니다.
4. 삭제 사실을 audit 로그에 남깁니다. 벡터는 남기지 않습니다.
5. 백업에 남은 사본은 `wrapped_dek` 삭제로 읽을 수 없게 하거나, 백업 보존 주기를 문서화해 그 안에 소멸되게 합니다.

```python
@app.post("/consents/{consent_id}/withdraw")
async def withdraw(consent_id: UUID, user=Depends(current_user)):
    async with db.transaction() as tx:
        c = await tx.fetchrow(
            "UPDATE consents SET withdrawn_at = now() "
            "WHERE consent_id = $1 AND person_id = $2 AND withdrawn_at IS NULL "
            "RETURNING person_id",
            consent_id, user.person_id,
        )
        if c is None:
            raise HTTPException(404)
        ref = await resolve_subject_ref(tx, user.person_id)      # subject_links 조회
        await tx.execute("DELETE FROM face_templates WHERE subject_ref = $1", ref)
        await tx.execute("DELETE FROM enrollment_sessions WHERE subject_ref = $1", ref)  # staging은 CASCADE
        await tx.execute("DELETE FROM subject_links WHERE subject_ref = $1", ref)        # wrapped_dek 포함
        await audit(tx, action="biometric_deleted", subject_ref=ref, actor=user.person_id)
    await gallery_cache.evict(ref)                               # 메모리 gallery에서도 제거
    return {"status": "deleted"}
```

### 대체 인증 수단

얼굴만으로 본인임을 확정할 수 없는 경우는 반드시 생깁니다.
대체 수단은 법적 요구이기 이전에 서비스가 멈추지 않기 위한 조건입니다.

- 동의하지 않은 사람, 동의를 철회한 사람
- 쌍둥이나 닮은 사람이 gallery에 있는 사람
- 외모가 크게 바뀌어 인식되지 않는 사람
- rate limit에 걸린 기기

Apple Face ID는 passcode 설정을 전제로 하고 \[7\], 토스는 닮은 얼굴이 있는 사용자에게 2차 인증을 요구합니다 \[12\].
비밀번호, QR, 휴대폰 번호 확인처럼 본인이 명시적으로 제시하는 수단을 하나 이상 둡니다.

## 8. 잊힐 권리: 얼굴 템플릿 폐기

폐기는 `DELETE` 한 줄이 아닙니다. 얼굴 정보가 존재하는 모든 위치에서 복구할 수 없게 만들고, 그렇게 했다는 사실을 증명하는 절차입니다. 얼굴은 바꿀 수 없으므로 어딘가에 남은 사본 하나가 기한 없는 위험이 됩니다.

### 언제 폐기하는가

| 계기 | 근거 | 처리 |
| --- | --- | --- |
| 동의 철회, 처리정지 요구 | 개인정보 보호법 제37조 | 식별 대상에서 즉시 제외한 뒤 폐기 |
| 삭제 요구 | 같은 법 제36조 | 폐기 후 결과를 요구받은 날부터 10일 이내에 통지 \[23\] |
| 보유 기간 만료, 목적 달성(탈퇴, 이용 종료) | 같은 법 제21조 | 지체 없이 폐기 |
| 재등록이나 모델 교체로 쓰지 않게 된 구 템플릿 | 목적 달성 | 유예 기간 후 폐기 |
| 완료되지 않은 등록 세션 | 목적 달성 | 만료 시 staging 삭제 |

본인이 요구하는 경우보다 요구 없이 시스템이 알아서 지워야 하는 경우가 더 많습니다. `consents.retention_until`과 세션 만료를 주기적으로 훑는 작업이 필요합니다. 조문 적용은 법무 검토로 확인합니다.

### 얼굴 정보는 어디에 남아 있는가

폐기 설계의 첫 단계는 목록 작성입니다. gallery 테이블만 지우면 아래 위치에 사본이 남습니다.

| 위치 | 남아 있는 것 | 폐기 방법 |
| --- | --- | --- |
| `face_templates` (`active`, `retired` 모두) | 임베딩 | 행 삭제 |
| `enrollment_staging`, `enrollment_sessions` | 임시 임베딩, 등록 메타 | 행 삭제 |
| `subject_links` | 회원 연결, `wrapped_dek` | 행 삭제. 암호문을 풀 수 없게 됨 |
| 서비스 메모리의 gallery 캐시 | 복호화된 벡터. 인스턴스마다 한 벌 | 모든 인스턴스에 제거 이벤트 전파, 주기적 전체 재적재로 누락 보정 |
| 벡터 인덱스 | 삭제된 행을 가리키는 인덱스 항목 | 정리(vacuum) 주기 설정 |
| DB 내부 흔적, 복제본 | 삭제된 행의 물리적 잔여, 변경 로그 | 정리 주기와 로그 보존 기간 설정 |
| 백업, 스냅샷 | 삭제 전 시점의 전체 사본 | 키 폐기 또는 보존 주기 내 소멸, 복원 시 재삭제 |
| `identification_events` | `subject_ref`가 붙은 식별 이력 | `subject_ref` 제거 또는 행 삭제 |
| 평가셋, 디버그 덤프, 학습 데이터 | 이미지나 임베딩 사본 | 사본 위치를 등록해 두고 함께 삭제 |
| 위탁 처리자, 외부 서비스 | 전달된 사본 | 삭제 요청 전달 후 완료 확인 |

마지막 두 줄이 가장 자주 빠집니다.
운영 데이터를 평가나 디버깅 용도로 복사할 때 그 사본을 기록해 두지 않으면 폐기 대상에서 영영 빠집니다.

### 복구할 수 없게 만든다

- **상태값 변경은 폐기가 아닙니다.** `status = 'deleted'`로 표시만 한 행은 여전히 저장돼 있습니다.
- **백업은 키로 처리합니다.** 6장의 사람 단위 데이터 키를 폐기하면 백업 속 암호문도 읽을 수 없습니다. 단, `wrapped_dek`이 같은 백업에 들어 있으면 복원으로 되살아납니다. 감싼 키는 장기 백업 대상에서 빼거나 키 관리 서비스 쪽에 보관하고 거기서 폐기합니다.
- **복원이 삭제를 되돌리지 않게 합니다.** 백업을 복원하면 그사이 폐기된 사람이 다시 나타납니다. 폐기 원장을 복원 대상 DB와 분리해 두고, 복원 직후 서비스 재개 전에 원장을 다시 적용합니다.

폐기 원장에는 `subject_ref`만 남습니다. `subject_links`가 삭제된 뒤에는 이 값으로 사람을 찾을 수 없습니다.

### 절차

1. **접수**: 얼굴이 아닌 수단으로 본인을 확인하고 폐기 요청을 기록합니다. 시스템이 시작한 폐기도 같은 표에 기록합니다.
2. **즉시 차단**: 템플릿 삭제와 캐시 제거를 가장 먼저 실행해 식별을 멈춥니다.
3. **저장소별 폐기**: 나머지 위치를 차례로 처리합니다. 각 단계는 다시 실행해도 결과가 같아야 합니다.
4. **검증**: 모든 저장소를 `subject_ref`로 다시 조회해 0건인지 확인합니다.
5. **통지와 증빙**: 본인에게 완료를 알리고, 폐기 기록을 보존합니다.

**`erasure_requests`**: 폐기 원장

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `request_id` | `uuid` PK |  |
| `subject_ref` | `uuid` NOT NULL |  |
| `reason` | `text` NOT NULL | `withdrawal` / `erasure_request` / `retention_expired` / `account_closed` / `superseded` |
| `requested_by` | `text` NOT NULL | `self` / `system` / 직원 ID |
| `requested_at`, `due_at` | `timestamptz` NOT NULL | 접수 시각, 처리 기한 |
| `steps` | `jsonb` NOT NULL | 저장소별 완료 시각 |
| `status` | `text` NOT NULL | `requested` / `purging` / `verified` / `notified` |
| `verified_at`, `notified_at` | `timestamptz` NULL |  |

```python
import json
from datetime import datetime, timezone
from uuid import UUID

async def run_erasure(request_id: UUID) -> None:
    """중간에 실패해도 다시 실행하면 남은 단계부터 이어서 처리한다."""
    req = await db.fetchrow(
        "SELECT subject_ref, steps FROM erasure_requests WHERE request_id = $1", request_id
    )
    ref, done = req["subject_ref"], dict(req["steps"] or {})

    async def step(name: str, action) -> None:
        if name in done:
            return
        await action()
        done[name] = datetime.now(timezone.utc).isoformat()
        await db.execute(
            "UPDATE erasure_requests SET steps = $2, status = 'purging' WHERE request_id = $1",
            request_id, json.dumps(done),
        )

    # 식별을 멈추는 단계를 먼저 실행한다
    await step("templates", lambda: db.execute(
        "DELETE FROM face_templates WHERE subject_ref = $1", ref))
    await step("cache", lambda: gallery_cache.evict_everywhere(ref))

    await step("sessions", lambda: db.execute(
        "DELETE FROM enrollment_sessions WHERE subject_ref = $1", ref))       # staging은 CASCADE
    await step("links_and_key", lambda: db.execute(
        "DELETE FROM subject_links WHERE subject_ref = $1", ref))
    await step("events", lambda: db.execute(
        "UPDATE identification_events SET subject_ref = NULL WHERE subject_ref = $1", ref))
    await step("copies", lambda: purge_registered_copies(ref))                # 평가셋, 위탁 처리자 등

    if await count_remaining(ref) == 0:                                       # 전 저장소 재조회
        await db.execute(
            "UPDATE erasure_requests SET status = 'verified', verified_at = now() "
            "WHERE request_id = $1",
            request_id,
        )
```

`gallery_cache`, `purge_registered_copies`, `count_remaining`은 설명용 stub입니다.

### 남기는 것과 남기면 안 되는 것

| 항목 | 판단 |
| --- | --- |
| 폐기 기록(누가, 언제, 어떤 사유로, 어떤 저장소를) | 남깁니다. 폐기했다는 증빙이며 얼굴 정보를 포함하지 않습니다 |
| 동의와 철회 이력 | 남깁니다. 보관 기간은 법무 검토로 정합니다 |
| `subject_ref`를 뺀 집계 통계 | 남길 수 있습니다 |
| 재가입 방지용으로 임베딩을 따로 보관 | 폐기와 충돌합니다. 별도의 근거와 동의 없이는 하지 않습니다 |
| 디버깅용으로 남겨 둔 실패 프레임 | 남기지 않습니다 |

### 얼굴 폐기와 회원 탈퇴는 다르다

얼굴 정보만 지우고 서비스는 계속 쓰려는 사람이 있을 수 있습니다.
폐기 요청은 계정 삭제와 분리된 경로로 받고, 완료 후에는 7장의 대체 인증 수단으로 이어지게 합니다.
요청 경로는 등록만큼 쉬워야 하고, 다시 등록하려면 동의부터 새로 받습니다.

## 9. 모델 마이그레이션과 재등록

원본 이미지를 보관하지 않는 설계에서 모델 교체는 곧 전원 재등록입니다.
새 모델로 임베딩을 다시 뽑을 이미지가 없기 때문입니다.
그래서 모델 버전 업데이트는 비용과 편익을 따져봐서 범위를 신중하게 결정해야합니다.

### 전환 방법

| 방법 | 내용 | 주의점 |
| --- | --- | --- |
| 신규만 새 모델, 기존은 점진 전환 | 전환 기간에 두 모델을 함께 돌림 | 추론 비용 2배. 모델별 threshold를 따로 관리 |
| 인증 성공 시 자동 갱신 | 구 모델로 높은 신뢰도로 식별되면 같은 프레임을 새 모델로 임베딩해 적립 | 동의 범위에 포함돼야 함. 오수락이 새 템플릿으로 굳을 위험 |
| 명시적 재등록 캠페인 | 기한을 두고 재등록 안내 | 참여율. 미참여자는 대체 수단으로 전환 |
| 하위 호환 학습 | 새 모델의 임베딩이 구 모델 임베딩과 비교 가능하도록 학습 \[20\] | 모델을 직접 학습할 때만 가능 |

자동 갱신은 Apple Face ID가 인증 성공 시 얼굴 데이터를 갱신하는 것과 같은 발상입니다 \[7\].
식별 프레임은 등록 프레임보다 품질이 낮으므로, 품질과 liveness 기준을 등록 수준으로 적용하고 여러 번 적립된 뒤에 활성화합니다.

### 절차

1. 자체 평가셋에서 새 모델을 같은 FPIR 기준으로 비교해 교체 여부를 정합니다.
2. 새 모델 버전과 그 threshold를 등록하고, 신규 등록을 새 모델로 전환합니다.
3. 전환 기간에는 probe를 두 모델로 임베딩해 각 버전의 gallery를 따로 검색합니다.
4. 전환율을 추적하며 남은 사람에게 재등록을 안내합니다.
5. 종료일 이후 구 버전 템플릿을 삭제하고, 미전환자는 대체 수단으로 인증한 뒤 재등록하게 합니다.

**`model_versions`**: 버전별 운영 설정

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `model_version` | `text` PK |  |
| `status` | `text` NOT NULL | `active` / `deprecated` / `retired` |
| `t_accept`, `t_margin` | `real` NOT NULL | 이 버전의 점수 분포에서 구한 값 |
| `calibrated_gallery_size` | `integer` | threshold를 구할 때의 gallery 크기 |
| `activated_at`, `retire_at` | `timestamptz` |  |

서로 다른 모델의 점수는 직접 비교하지 않습니다. 버전마다 따로 판정한 뒤 결과만 합칩니다.

```python
def identify_multi(aligned_face, models, galleries, cfg):
    """전환 기간용. models/galleries/cfg는 model_version을 key로 가진다."""
    matched = set()
    ambiguous = False
    for ver, model in models.items():
        probe, _ = to_template(model.embed(aligned_face))
        g = galleries[ver]
        ref, outcome = identify(probe, g.embeddings, g.subject_refs,
                                cfg[ver].t_accept, cfg[ver].t_margin)
        if outcome == "match":
            matched.add(ref)
        elif outcome == "ambiguous":
            ambiguous = True

    if len(matched) == 1 and not ambiguous:
        return matched.pop(), "match"
    if matched or ambiguous:
        return None, "ambiguous"        # 두 모델이 서로 다른 사람을 지목한 경우 포함
    return None, "no_match"
```

### 주기적 재등록은 필요한가

얼굴은 시간이 지나며 변하지만, 성인의 경우 그 속도는 생각보다 느립니다. Best-Rowden과 Jain의 종단 연구는 본인 간 점수가 시간에 따라 내려가도 대상자의 99%가 약 6년까지는 FAR 0.01%에서 인식된다고 보고했습니다 \[21\]. 이 연구는 성인 mugshot과 당시 상용 matcher를 대상으로 했으므로 그대로 일반화할 수는 없습니다.

따라서 6개월이나 1년 주기의 재등록을 노화만으로 정당화하기는 어렵습니다. 대신 두 가지를 권합니다.

- **신호 기반 재등록**: 회원별 매칭 점수가 꾸준히 내려가거나, 얼굴 인식 실패 후 대체 수단으로 통과하는 일이 반복되면 그 사람에게만 재등록을 안내합니다.
- **다른 이벤트와 묶기**: 모델 마이그레이션이나 동의 갱신처럼 어차피 회원과 접점이 생기는 시점에 재등록을 함께 진행합니다.

고정 주기를 둔다면 동의서의 보유 기간과 맞춘 정책적 선택으로 설명하는 편이 정확합니다.

## 10. 운영 모니터링

운영 로그의 `match`와 `no_match` 비율만으로는 FAR과 FRR을 알 수 없습니다. `no_match`에는 정상적으로 거절된 미등록자와 잘못 거절된 회원이 섞여 있고, `match`에는 정상 식별과 오식별이 섞여 있습니다. 정답이 없는 로그에서는 직접 측정할 수 있는 것과 추정만 가능한 것을 나눠서 봐야 합니다.

### 지표

| 지표 | 계산 방법 | 알려 주는 것 |
| --- | --- | --- |
| 결과 분포 | 기기·일자별 `match` / `no_match` / `ambiguous` / `liveness_fail` / `quality_fail` 비율 | 급변 감지. 카메라 위치나 조명 변화, 배포 문제 |
| 수락 점수 분포 | `match`의 top-1 점수 분위수, threshold 근처 비율 | threshold 여유. 모델·gallery 변화의 영향 |
| margin 분포 | 1위와 2위의 점수 차 | 닮은 사람 쌍의 증가 |
| 본인 거절 추정 | 얼굴 실패 직후 같은 기기에서 대체 수단으로 통과한 비율 | FNIR의 하한 추정 |
| 오식별 추정 | 이의 제기, 직원 정정, 물리적으로 불가능한 연속 식별 | FPIR의 하한 추정 |
| 미등록자 probe 검사 | 동의받은 미등록자 평가셋을 현재 gallery에 주기적으로 검색 | 현재 gallery 크기에서의 FPIR 실측 |
| 기기별 liveness 실패율 | 기기·시간대별 추이 | 공격 시도 또는 환경 문제 |
| 회원별 점수 추이 | 최근 수락 점수의 이동 평균 | 외형 변화. 재등록 안내 대상 |
| 동의 버전 분포 | `consent_version`별 인원 | 동의서 변경 시 재동의 대상 |
| 등록자별 품질 | `enrolled_by_staff_id`별 등록 건수와 평균 품질 점수 | 등록 절차 편차, 교육 필요 지점 |

미등록자 probe 검사가 가장 직접적입니다. Gallery가 커질수록 FPIR이 올라간다는 4장의 내용을 운영 중에 수치로 확인하는 방법이고, threshold 재조정 시점을 알려 줍니다.

### 스키마

**`identification_events`**: 식별 시도 기록(접근 통제 대상)

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `event_id` | `uuid` PK |  |
| `occurred_at` | `timestamptz` NOT NULL |  |
| `device_id` | `text` NOT NULL |  |
| `outcome` | `text` NOT NULL | `match` / `no_match` / `ambiguous` / `liveness_fail` / `quality_fail` / `fallback_success` |
| `subject_ref` | `uuid` NULL | `match`일 때만 |
| `top1_score`, `margin` | `real` NULL |  |
| `liveness_score`, `quality_score` | `real` NULL |  |
| `model_version` | `text` NOT NULL |  |

```sql
-- 기기별 일일 결과 분포
SELECT date_trunc('day', occurred_at) AS day, device_id, outcome, count(*) AS n
FROM identification_events
WHERE occurred_at >= now() - interval '14 days'
GROUP BY 1, 2, 3;

-- 본인 거절 추정: 얼굴 실패 후 2분 안에 같은 기기에서 대체 수단으로 통과한 비율
SELECT date_trunc('day', f.occurred_at) AS day,
       avg((a.event_id IS NOT NULL)::int) AS likely_false_reject_ratio
FROM identification_events f
LEFT JOIN LATERAL (
    SELECT event_id
    FROM identification_events a
    WHERE a.device_id = f.device_id
      AND a.outcome = 'fallback_success'
      AND a.occurred_at >  f.occurred_at
      AND a.occurred_at <= f.occurred_at + interval '2 minutes'
    LIMIT 1
) a ON true
WHERE f.outcome IN ('no_match', 'ambiguous')
GROUP BY 1;
```

### 모니터링 자체의 법적·보안 영향

모니터링 데이터도 설계 대상입니다. "누가 언제 어느 기기에서 식별됐다"는 기록은 그 자체로 출입 이력이라는 개인정보입니다.

- **목적과 고지**: 서비스 품질 관리 목적의 기록이 동의서와 처리방침의 범위 안에 있는지 확인합니다.
- **보존 기간**: 원시 이벤트는 짧게 보관하고, 그 뒤에는 `subject_ref`를 뺀 집계만 남깁니다.
- **회원별 점수 추이**: 원시 점수 이력을 쌓지 않고 이동 평균 같은 요약값만 유지합니다.
- **직원별 통계**: 등록 담당자 단위의 집계는 직원에 대한 모니터링이 됩니다. 목적을 품질 관리로 한정하고 당사자에게 알립니다.
- **점수 접근 통제**: 유사도 점수는 6장에서 본 것처럼 공격에 쓰일 수 있으므로 대시보드에는 분포만 노출합니다.

## 마무리: 설계 체크리스트

Gallery DB 설계는 벡터를 어디에 넣을지보다 "무엇을 근거로 수락하고, 유출과 변경에 어떻게 대비하는가"를 정하는 일입니다. 아래 항목에 모두 답할 수 있으면 출발선에 선 것입니다.

- [ ] 모든 템플릿 행에 파이프라인 전체를 가리키는 `model_version`이 있고, 검색이 이 값으로 필터링된다
- [ ] 등록 각도와 장수를 자체 데이터에서 같은 FPIR 기준으로 비교해 정했다
- [ ] 등록이 staging과 원자적 commit으로 나뉘고, 세션 내 일관성 검사와 gallery 중복 검사가 있다
- [ ] threshold를 현재 gallery 크기에서 미등록자 probe로 구했고, 재조정 기준이 있다
- [ ] exact search로 충분한지 먼저 확인했고, ANN을 쓴다면 recall을 측정한다
- [ ] 등록 경로에 liveness와 세션 바인딩이 있고, 실패 시 대체 수단으로 이어진다
- [ ] 템플릿이 암호화돼 있고 회원 ID와 분리돼 있다
- [ ] 응답과 로그에 벡터, 이미지, 점수, 회원 ID가 기록되지 않는다
- [ ] 별도 동의 없이는 등록할 수 없고, 동의 버전과 문구를 증빙할 수 있다
- [ ] 철회 시 DB, 메모리 캐시, 백업까지 삭제 경로가 정의돼 있다
- [ ] 모델 교체 절차와 버전별 threshold 관리 방법이 정해져 있다
- [ ] 운영 중 FPIR과 FNIR을 추정하는 방법이 있고, 모니터링 데이터의 보존 기간이 정해져 있다

## References

1. J. Deng, J. Guo, N. Xue, S. Zafeiriou. "ArcFace: Additive Angular Margin Loss for Deep Face Recognition." CVPR 2019. [arXiv:1801.07698](https://arxiv.org/abs/1801.07698)
2. Q. Meng, S. Zhao, Z. Huang, F. Zhou. "MagFace: A Universal Representation for Face Recognition and Quality Assessment." CVPR 2021. [arXiv:2103.06627](https://arxiv.org/abs/2103.06627)
3. pgvector: Open-source vector similarity search for Postgres. [github.com/pgvector/pgvector](https://github.com/pgvector/pgvector)
4. S. Sengupta et al. "Frontal to Profile Face Verification in the Wild." WACV 2016. [PDF](https://engineering.jhu.edu/vpatel36/wp-content/uploads/2018/08/WACV2016_CFP.pdf)
5. B. Maze et al. "IARPA Janus Benchmark - C: Face Dataset and Protocol." ICB 2018.
6. J. Yang et al. "Neural Aggregation Network for Video Face Recognition." CVPR 2017. [arXiv:1603.05474](https://arxiv.org/abs/1603.05474)
7. Apple. "About Face ID advanced technology." [support.apple.com/en-us/102381](https://support.apple.com/en-us/102381)
8. P. Terhörst et al. "SER-FIQ: Unsupervised Estimation of Face Image Quality Based on Stochastic Embedding Robustness." CVPR 2020. [arXiv:2003.09373](https://arxiv.org/abs/2003.09373)
9. P. Grother, M. Ngan, K. Hanaoka. "Face Recognition Vendor Test (FRVT) Part 2: Identification." NISTIR 8271. [doi:10.6028/NIST.IR.8271](https://doi.org/10.6028/NIST.IR.8271) 및 NIST, "Relating 1:1 and 1:N False Positive Rates." [PDF](https://pages.nist.gov/frvt/reports/demographics/implications_for_1N.pdf)
10. Y. Malkov, D. Yashunin. "Efficient and Robust Approximate Nearest Neighbor Search Using Hierarchical Navigable Small World Graphs." IEEE TPAMI, 2020. [arXiv:1603.09320](https://arxiv.org/abs/1603.09320)
11. ISO/IEC 30107-3. "Biometric presentation attack detection - Part 3: Testing and reporting."
12. 지디넷코리아. "700만명 모은 토스 '페이스페이'…보안 난이도, 금융권 수준 강화." 2026-09-02. [zdnet.co.kr](https://zdnet.co.kr/view/?no=20260902101653)
13. G. Mai, K. Cao, P. C. Yuen, A. K. Jain. "On the Reconstruction of Face Images from Deep Face Templates." IEEE TPAMI 41(5), 2019. [arXiv:1703.00832](https://arxiv.org/abs/1703.00832)
14. H. O. Shahreza, S. Marcel. "Face Reconstruction from Facial Templates by Learning Latent Space of a Generator Network." NeurIPS 2023. [papers.neurips.cc](https://papers.neurips.cc/paper_files/paper/2023/hash/29e4b51d45dc8f534260adc45b587363-Abstract-Conference.html)
15. ISO/IEC 24745. "Information security, cybersecurity and privacy protection - Biometric information protection."
16. V. N. Boddeti. "Secure Face Matching Using Fully Homomorphic Encryption." BTAS 2018.
17. 개인정보 보호법 제23조(민감정보의 처리 제한), 같은 법 시행령 제18조(민감정보의 범위).
18. 개인정보보호위원회. "생체정보 보호 가이드라인." 2021-09. 해설 기사: [보안뉴스](https://m.boannews.com/html/detail.html?idx=102064), [법률신문](https://www.lawtimes.co.kr/news/articleViewAmp.html?idxno=172836)
19. 개인정보보호위원회 고시. "개인정보의 안전성 확보조치 기준" 제7조(개인정보의 암호화).
20. Y. Shen, Y. Xiong, W. Xia, S. Soatto. "Towards Backward-Compatible Representation Learning." CVPR 2020. [arXiv:2003.11942](https://arxiv.org/abs/2003.11942)
21. L. Best-Rowden, A. K. Jain. "Longitudinal Study of Automatic Face Recognition." IEEE TPAMI 40(1), 2018.
22. 토스. "토스, '페이스페이' 가입자 100만 명 돌파." 2025-11-18. [toss.im](https://toss.im/tossfeed/article/42877)

23) 개인정보 보호법 제21조(개인정보의 파기), 제36조(개인정보의 정정·삭제), 제37조(개인정보의 처리정지 등), 같은 법 시행령 제43조. [시행령 제43조 조문](https://itwiki.kr/w/%EA%B0%9C%EC%9D%B8%EC%A0%95%EB%B3%B4_%EB%B3%B4%ED%98%B8%EB%B2%95_%EC%8B%9C%ED%96%89%EB%A0%B9_%EC%A0%9C43%EC%A1%B0)

24) Baltanas, S.-F.; Ruiz-Sarmiento, J.-R.; Gonzalez-Jimenez, J. Improving the Head Pose Variation Problem in Face Recognition for Mobile Robots. Sensors 2021, 21, 659. doi:10.3390/s21020659