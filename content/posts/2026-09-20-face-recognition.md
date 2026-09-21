---
title: "Smart CCTV, 얼굴 인식 방법"
date: 2026-09-21
category: ai
summary: CCTV에 찍힌 얼굴(Probe)이 등록 DB(Gallery)의 누구인지 판정하기까지의 전 과정을 정리합니다. 얼굴을 512차원 벡터로 바꾸는 Embedder, 코사인 유사도가 비교 기준이 된 이유, Detection → Alignment → Representation 3단계의 역할 분담, InsightFace `app.get()` 한 줄의 내부 동작과 `norm_crop`의 아핀 변환, 사전학습 모델의 라이선스 제약과 대안, CPU 정렬과 GPU 배치 추론을 분리하는 속도 최적화, Detector를 교체할 때 맞춰야 할 랜드마크 규격, 그리고 Gallery와 Probe 파이프라인이 어긋났을 때 벌어지는 일까지 다룹니다.
tags: ["Smart CCTV", "Face Recognition", "InsightFace", "ArcFace", "Computer Vision"]
---

> **TL;DR**
>
> 얼굴 인식은 사진 두 장을 눈으로 견주어 "닮았다"고 판단하는 일이 아니라, **얼굴을 512차원 벡터로 바꾼 뒤 두 벡터가 이루는 각도를 비교하는 작업**입니다. 현장에서 방금 들어온 얼굴(**Probe**)과 미리 등록해 둔 얼굴(**Gallery**)을 같은 Embedder에 통과시키고, 코사인 유사도가 임계값을 넘는지로 동일인 여부를 판정합니다.
>
> 그런데 Embedder는 아무 이미지나 받지 않습니다. ArcFace 계열 모델은 **112×112로 정렬된 얼굴 패치**만 입력으로 학습됐기 때문에, 앞단에 **Detection → Alignment**가 반드시 붙습니다. InsightFace의 `app.get()` 한 줄이 실제로 하는 일이 바로 이 3단계이고, 그 핵심인 `norm_crop`은 5개 랜드마크를 표준 템플릿에 맞추는 **아핀 변환(Affine Transform)** 한 번으로 회전 보정·크기 조절·위치 이동·크롭을 동시에 끝냅니다.
>
> 실무에서 갈리는 지점은 세 가지입니다. **라이선스**(InsightFace 사전학습 가중치는 비상업 연구용이라 상업 서비스에는 그대로 쓸 수 없습니다), **속도**(`get()` 반복 호출 대신 CPU 정렬과 GPU 배치 추론을 분리해야 GPU가 놉니다), 그리고 **일관성**(Gallery를 만든 파이프라인과 Probe를 처리하는 파이프라인이 다르면 오인식 사고가 발생합니다).

## 1. 용어 정리 — Probe와 Gallery

얼굴 인식 시스템의 구조를 이야기하려면 먼저 **Probe**와 **Gallery**라는 두 가지 핵심 용어를 정리해야 합니다.

### Probe (프로브)

- **정의**: 시스템이 "이 사람이 누구인지 찾아내라"고 입력받는 **조회용(검색용) 이미지·동영상 데이터**
- **역할**: 정답을 찾기 위해 질문을 던지는 주체
- **예시**
    - CCTV 영상에서 실시간으로 검출된 인물의 Bounding Box 영역
    - 공항 출입국 관리대 카메라에 찍힌 **승객의 현재 얼굴 사진**
    - 관제 시스템에서 추적하고자 하는 **수배자의 CCTV 캡처 화면**

### Gallery (갤러리)

- **정의**: Probe와 비교할 수 있도록 미리 등록되어 있는 **참조 데이터베이스(Reference DB)** 집합
- **역할**: Probe가 들어왔을 때 "이 중에 일치하는 사람이 있는가?"를 찾기 위해 뒤지는 대상
- **예시**
    - Smart CCTV 시스템에 미리 저장된 **사람 사진 DB**
    - 여권 정보 시스템에 저장된 **여권 사진 DB**
    - 기업 출입 시스템에 등록된 **전 직원 사원증 사진 DB**

즉 **Probe는 현장에서 방금 들어온 얼굴**, **Gallery는 미리 잘 찍어 등록해 둔 얼굴**입니다. Gallery는 통제된 환경에서 한 번 잘 찍으면 되지만, Probe는 매 순간 통제되지 않은 현장 조건에 그대로 노출됩니다.

## 2. 임베더와 임베딩 벡터

Gallery에 인물 사진 데이터를 등록해 둔 상태에서, CCTV 영상 속에 해당 인물이 나타났을 때 컴퓨터는 이를 어떻게 동일인으로 판별할 수 있을까요?
컴퓨터가 얼굴을 인식하는 방식은 다양하지만, 현재 가장 **표준적으로 사용되는 방식은 AI 모델을 통해 얼굴 이미지를 고차원 벡터(예: 512차원)로 변환한 뒤 비교**하는 것입니다.
이때 얼굴 이미지에서 특징을 추출해 고차원 벡터로 변환해 주는 AI 모델을 **임베더(Embedder)**, 추출된 고차원 벡터를 **임베딩 벡터(Embedding Vector)** 라고 부릅니다.
```py
# Pseudo code: 얼굴 이미지를 임베딩 벡터로 변환하는 과정
model = Embedder(dimension=512)

# 입력 이미지로부터 512차원의 고차원 특징 벡터 추출
embedding_vector = model(image) 

# Output 예시: [0.20, 0.35, ..., -0.12] (length = 512)
```
## 3. 코사인 유사도와 임계값
이렇게 추출된 Embedding Vector를 Gallery와 Probe에서 모두 추출하여 Vector간 유사도 비교를 통해 두 이미지 유사도가 높은지 또는 낮은지를 통해 동일인 여부를 판정합니다.

```py
import numpy as np
# Pseudo code: Gallery와 Probe의 임베딩 벡터 비교 과정
model = Embedder(dimension=512)

# 각 이미지로부터 512차원 특징 벡터 추출
gallery_vector = model(gallery_image) 
probe_vector = model(probe_image)

# 코사인 유사도(Cosine Similarity) 계산: (x · y) / (||x|| * ||y||)
similarity = np.dot(gallery_vector, probe_vector) / (np.linalg.norm(gallery_vector) * np.linalg.norm(probe_vector))

# 임계값(Threshold) 설정을 통한 동일인 판정
# ※ threshold 값은 하이퍼파라미터로, 시스템 목적에 맞춰 최적의 값을 찾아야 합니다.
threshold = 0.5

if similarity > threshold:
    result = "same_person"
else:
    result = "different_person"
```

**왜 코사인 유사도(Cosine Similarity)를 주로 사용할까?**
두 벡터를 비교하는 방법은 유클리드 거리($\Vert{}x - y\Vert{}$, **L2 Distance**라고도 부릅니다)나 단순 내적 등 여러 가지가 있지만, 현업과 연구 모두에서 **코사인 유사도**를 가장 광범위하게 사용합니다.
그 이유는 현재 얼굴 인식(Face Recognition) 분야에서 사실상 표준으로 자리 잡은 **ArcFace** 계열 모델의 Loss 함수(Additive **Angular** Margin Loss)가, 애초에 **벡터 사이의 각도(Angular)** 를 기준으로 서로 다른 사람을 떼어놓도록 설계되었기 때문입니다. 즉 **학습이 최적화한 축과 추론에서 비교하는 축을 일치시키는 것**입니다.
- **코사인 유사도의 범위**: $-1$ ~ $1$ 사이의 값을 가지며, **$1$에 가까울수록 두 벡터의 방향이 일치하여 유사도가 높음**을 의미합니다.
- **L2 거리와의 관계**: 벡터를 L2 정규화($\Vert{}x\Vert{} = 1$)해 두면 $\Vert{}x-y\Vert{}^2 = 2(1 - \cos\theta)$가 성립합니다. 코사인 유사도가 클수록 L2 거리는 작아지는 **단조 관계**라서, 정규화만 되어 있다면 둘 중 무엇으로 순위를 매겨도 결과는 뒤집히지 않습니다. 그럼에도 코사인을 쓰는 이유는 값의 범위가 $-1$ ~ $1$로 고정되어 **임계값을 해석하고 시스템 간에 옮기기 쉽기** 때문입니다.
- **임계값(Threshold)의 중요성**: 동일인을 정확히 맞추는 성능과 타인을 잘못 판정하지 않는 성능 간의 균형(Trade-off)을 고려하여 적절한 `threshold`를 설정하는 것이 얼굴 인식 시스템 구축의 핵심입니다. 이 값은 모델·파이프라인·현장 조건이 바뀔 때마다 다시 설정해야 하는 값이지, 논문에서 그대로 옮겨올 수 있는 상수가 아닙니다.

## 4. Face Recognition Pipeline
Embedder를 통한 벡터 유사도 비교는 얼굴 인식의 핵심이지만, 실제 현장에서는 여러 AI 모듈과 이미지 프로세싱 기술이 하나의 파이프라인(Pipeline)으로 엮여 작동합니다. CCTV 영상 등 원본 입력으로부터 신원을 최종 확인하기까지의 과정은 다음과 같습니다.

1. **얼굴 감지 (Detection)**: *"이미지 어디에 얼굴이 있는가?"*
    * 입력 이미지 전체를 탐색하여 얼굴의 위치(Bounding Box: `x, y, w, h`)와 눈·코·입 등의 핵심 랜드마크(Keypoints) 위치를 검출합니다.
    * *주요 모델*: RetinaFace, YOLO-Face, MTCNN, MediaPipe 등
    * *주의*: 일부 Detector(e.g., YOLO)는 랜드마크 없이 **Bounding Box만 반환**하기도 합니다. 이 경우 다음 단계인 Alignment를 위해 **별도의 랜드마크 검출 모델(예: Dlib, FAN 등)을 추가로 연결**해야 합니다.

2. **얼굴 이미지 정렬 (Alignment)**: *"기울어진 얼굴을 규격화된 좌표계 위에 똑바로 올려놓기"*
    * Detection 단계에서 얻은 랜드마크 좌표를 기준으로 **아핀 변환(Affine Transform)** 을 적용해, 두 눈을 잇는 선이 수평이 되고 이목구비가 정해진 위치에 오도록 맞춥니다.
    * *주의*: 이 단계가 보정하는 것은 **화면 평면 안에서의 회전·크기·위치(in-plane)** 입니다. 고개를 옆으로 돌린 각도(yaw)나 위아래로 숙인 각도(pitch)처럼 **화면 밖 방향의 포즈까지 정면으로 되돌려 주지는 않습니다.**

3. **특징 추출 및 신원 확인 (Representation & Verification)**: *"잘라낸 이 얼굴은 누구인가?"*
    * 정렬 및 크롭(Crop)이 완료된 **단일 얼굴 패치 이미지**를 Embedder에 입력하여 고차원 특징 벡터(예: 512차원)로 변환하고 Gallery DB와 비교합니다.
    * *주요 모델*: ArcFace, CosFace, FaceNet 등

말로만 보면 추상적이니, 이미지 한 장이 이 세 단계를 지나며 어떤 모습으로 바뀌는지 따라가 보겠습니다.

<div style="display:flex;gap:0.4rem;align-items:flex-start;justify-content:center;flex-wrap:wrap;margin:1.5rem 0;"><figure style="flex:0 0 auto;margin:0;width:135px;text-align:center;"><a href="/images/face-recognition/lenna-rotated.png" target="_blank" rel="noopener" style="border-bottom:none;"><img src="/images/face-recognition/lenna-rotated.png" alt="챙 넓은 모자를 쓴 인물이 어깨 너머로 카메라를 바라보는 Lenna 이미지가 한쪽으로 기울어진 채 놓여 있는 그림. 얼굴 외에 모자, 어깨, 배경 벽과 거울이 화면의 대부분을 차지한다" style="height:150px;width:auto;max-width:100%;margin:0 auto;display:block;"></a><figcaption style="font-size:0.8rem;color:#666;margin-top:0.5rem;line-height:1.5;">입력 프레임<br>얼굴은 일부, 게다가 기울어짐</figcaption></figure><span style="align-self:center;flex:0 0 auto;font-size:1.1rem;color:#999;padding-bottom:2.4rem;">→</span><figure style="flex:0 0 auto;margin:0;width:135px;text-align:center;"><a href="/images/face-recognition/lenna-rotated-box.png" target="_blank" rel="noopener" style="border-bottom:none;"><img src="/images/face-recognition/lenna-rotated-box.png" alt="기울어진 Lenna 이미지 위에 얼굴 영역만 초록색 직사각형 bounding box로 표시된 그림. 박스는 이마부터 턱까지, 양쪽 볼을 포함하는 범위를 감싸고 있고 모자와 어깨, 배경은 박스 바깥에 남아 있다" style="height:150px;width:auto;max-width:100%;margin:0 auto;display:block;"></a><figcaption style="font-size:0.8rem;color:#666;margin-top:0.5rem;line-height:1.5;">① Detection<br>얼굴 위치(Bounding Box) 검출</figcaption></figure><span style="align-self:center;flex:0 0 auto;font-size:1.1rem;color:#999;padding-bottom:2.4rem;">→</span><figure style="flex:0 0 auto;margin:0;width:135px;text-align:center;"><a href="/images/face-recognition/lenna-rotated-crop.png" target="_blank" rel="noopener" style="border-bottom:none;"><img src="/images/face-recognition/lenna-rotated-crop.png" alt="기울어진 Lenna 이미지에서 bounding box 영역만 잘라낸 작은 얼굴 이미지. 배경과 어깨는 사라졌지만 얼굴 자체는 여전히 한쪽으로 기울어져 있고 모서리에 모자 일부가 남아 있다" style="height:150px;width:auto;max-width:100%;margin:0 auto;display:block;"></a><figcaption style="font-size:0.8rem;color:#666;margin-top:0.5rem;line-height:1.5;">Crop<br>배경은 걷혔지만 기울기는 남음</figcaption></figure><span style="align-self:center;flex:0 0 auto;font-size:1.1rem;color:#999;padding-bottom:2.4rem;">→</span><figure style="flex:0 0 auto;margin:0;width:135px;text-align:center;"><a href="/images/face-recognition/lenna-face.png" target="_blank" rel="noopener" style="border-bottom:none;"><img src="/images/face-recognition/lenna-face.png" alt="정렬을 마친 Lenna의 얼굴 패치. 두 눈을 잇는 선이 수평이 되도록 회전이 보정되어 얼굴이 똑바로 서 있고, 이마부터 입술 아래까지 얼굴 영역이 화면을 가득 채운다" style="height:150px;width:auto;max-width:100%;margin:0 auto;display:block;"></a><figcaption style="font-size:0.8rem;color:#666;margin-top:0.5rem;line-height:1.5;">② Alignment<br>두 눈이 수평이 된 얼굴 패치</figcaption></figure></div>

**③ Representation** — 마지막 얼굴 패치가 Embedder를 거쳐 512차원 벡터가 되고, 3절의 코사인 유사도로 Gallery 벡터와 비교됩니다. 즉 Detection과 Alignment는 **Embedder가 볼 수 있는 형태로 이미지를 다듬는 전처리 단계**이고, 각 모듈의 동작 원리는 별도의 글에서 자세히 다루겠습니다.

> **얼굴 정렬(Alignment) 단계가 필요한 이유**
> Alignment 과정은 선택처럼 보일 수 있지만, **실제 시스템 구축 시에는 필수 모듈**로 분류됩니다.
> 대표적으로 ArcFace 모델의 경우 원본 얼굴 이미지가 아닌 **112×112 크기로 정렬(Align)된 얼굴 패치만 입력받도록 설계 및 학습**되었기 때문에, Alignment 과정이 생략될 경우 임베딩 성능이 급격히 저하됩니다.

## 5. InsightFace

엣지(Edge) 디바이스처럼 특별한 자원 제약이 없다면, 현재 얼굴 인식 분야에서는 속도와 성능이 모두 우수한 **ArcFace 계열 모델**이 사실상 기본 선택지입니다.

[**InsightFace**](https://github.com/deepinsight/insightface) 라이브러리는 앞서 살펴본 Face Recognition Pipeline(Detection $\rightarrow$ Alignment $\rightarrow$ Embedding)을 모두 내장하고 있어, 몇 줄의 코드만으로 전체 과정을 한 번에 처리할 수 있습니다.

```python
import cv2
import insightface
from insightface.app import FaceAnalysis

# 1. 모델 파이프라인 초기화 (예: 'buffalo_l', 'antelopev2' 등 선택)
app = FaceAnalysis(name='buffalo_l')
app.prepare(ctx_id=0, det_size=(640, 640))  # ctx_id: 0(GPU), -1(CPU)

# 2. 이미지 로드
img = cv2.imread('test.jpg')

# 3. 얼굴 검출, 정렬, 임베딩 추출을 한 번에 수행
faces = app.get(img)

# 4. 결과 확인 (검출된 인원수 및 특징 벡터 정보)
print(f'Detected faces: {len(faces)}')
for face in faces:
    print('BBox:', face.bbox)                 # 얼굴 위치 좌표 (Bounding Box)
    print('Embedding shape:', face.embedding.shape)  # 추출된 512차원 특징 벡터

```

> **InsightFace 사전학습 모델의 라이선스 주의**
> `buffalo_l`, `antelopev2` 같은 InsightFace 공식 사전학습 모델은 **비상업적 연구 목적(non-commercial research only)으로만 배포**됩니다. 라이브러리 코드 자체는 MIT지만 **가중치는 별도 조건**이라, 연구·프로토타입 단계에서는 자유롭게 써도 실제 제품에 그대로 사용하면 라이선스 위반이 될 수 있습니다.
> 대안으로 허깅페이스의 [**fal/AuraFace**](https://huggingface.co/fal/AuraFace-v1)가 있습니다. AuraFace 역시 **ArcFace 계열 임베더**라 앞서 설명한 파이프라인과 동일한 구조를 가지며, **InsightFace 라이브러리는 그대로 쓰고 모델 디렉터리만 갈아 끼우는** 방식으로 교체할 수 있습니다.
>
> ```python
> from huggingface_hub import snapshot_download
> from insightface.app import FaceAnalysis
>
> # 모델 가중치를 models/auraface 아래로 내려받는다
> snapshot_download('fal/AuraFace-v1', local_dir='models/auraface')
>
> # name/root만 바뀌고, app.get(img) 이후의 코드는 위와 완전히 동일하다
> app = FaceAnalysis(name='auraface', root='.', providers=['CUDAExecutionProvider'])
> app.prepare(ctx_id=0, det_size=(640, 640))
> ```
>
> 다만 모델 교체 시 임베딩 공간이 달라지므로 **모델을 바꾸면 Gallery 벡터를 전부 다시 추출**해야 하고, 3절에서 정한 코사인 유사도 임계값도 새로 튜닝해야 합니다. 라이선스 조건은 시점에 따라 바뀔 수 있으니 도입 전에 각 모델 카드를 직접 확인하는 편이 안전합니다.

---

### `app.get()` 한 줄이 실제로 하는 일

InsightFace의 `FaceAnalysis.get()` 메서드 내부 소스코드를 살펴보면 앞서 다룬 파이프라인이 그대로 구현되어 있음을 확인할 수 있습니다.

```python
# insightface/app/face_analysis.py 중 일부
def get(self, img, max_num=0):
    # 1. Detection & Keypoints(Landmarks) 추출
    bboxes, kpss = self.det_model.detect(img,
                                         max_num=max_num,
                                         metric='default')
    if bboxes.shape[0] == 0:
        return []

    ret = []
    # detection 결과로 반환된 한 이미지 내 여러 얼굴 bbox 및 Keypoints를 순회
    for i in range(bboxes.shape[0]):
        bbox = bboxes[i, 0:4]
        det_score = bboxes[i, 4]
        kps = kpss[i] if kpss is not None else None
        
        # 2. BBox 및 Landmark 정보를 가진 Face 객체 생성
        face = Face(bbox=bbox, kps=kps, det_score=det_score)
        
        # 3. 등록된 하위 모델들(Landmark Refinement, Embedder, Gender/Age 등) 순회 연산
        for taskname, model in self.models.items():
            if taskname == 'detection':
                continue
            model.get(img, face)  # face 객체 내부 값(embedding 등) 업데이트
            
        ret.append(face)
    return ret

```

#### 소스코드 핵심 동작 요약

1. **`self.det_model`**: 원본 이미지에서 모든 얼굴의 Bounding Box와 랜드마크(Keypoints)를 동시에 검출합니다.
2. **`Face` 객체 생성**: 검출된 좌표 정보를 바탕으로 각 인물별 `Face` 인스턴스를 생성합니다.
3. **`self.models` 순회 연산**: Detection 이후의 하위 모델들(`Embedder`, 정밀 랜드마크 추정, 성별/나이 예측 모델 등)을 순차적으로 실행하며 `face` 객체에 데이터(Embedding 등)를 채워 넣습니다.

> 💡 **최적화 팁 (Optimization Tip)**
> `self.models`에는 신원 확인(Verification)에 필요한 `Embedder` 외에도 성별/나이 추정과 같은 부가 기능 모델이 함께 로드될 수 있습니다.
> 만약 시스템에서 **오직 신원 확인을 위해 임베딩 벡터만 필요하다면, 불필요한 부가 기능 모델을 로드 대상에서 제외**해 처리 속도와 메모리를 크게 아낄 수 있습니다. `FaceAnalysis`는 `allowed_modules` 인자로 로드할 모듈을 직접 지정할 수 있습니다.
>
> ```python
> # detection + recognition만 로드 (성별/나이·정밀 랜드마크 모델은 로드하지 않음)
> app = FaceAnalysis(name='buffalo_l', allowed_modules=['detection', 'recognition'])
> ```

## 6. InsightFace 모듈별로 뜯어보기

InsightFace의 내부 동작 원리를 이해하면, 상황에 맞게 특정 모듈을 다른 모델로 교체하거나 **파이프라인을 최적화하여 처리 속도(FPS)를 극대화**할 수 있습니다.

### (1) Detector 모듈

InsightFace의 기본 Detector로는 주로 **SCRFD** 또는 **RetinaFace** 계열 모델이 사용됩니다. 이 모델들은 얼굴 위치(Bounding Box)뿐만 아니라 5개의 핵심 랜드마크(양 눈, 코, 양 입꼬리 좌표)를 동시에 반환합니다. 이 "Detection이 랜드마크까지 같이 준다"는 점이 뒤의 Alignment 단계를 별도 모델 없이 처리할 수 있게 해 주는 전제입니다.

```python
bboxes, kpss = self.det_model.detect(img, max_num=max_num, metric='default')
                                        
# Detector 반환값 예시
# bboxes: [[x1, y1, x2, y2, score], ...]  (Shape: [N, 5])
# kpss:   [[[x1, y1], [x2, y2], ..., [x5, y5]], ...] (Shape: [N, 5, 2])
```

#### 실무 엔지니어링 포인트

1. **자동 Pre-processing (Resize)**
`self.det_model.detect` 내부에서 입력 이미지를 모델 전용 크기로 자동 Resize 처리하므로, 전처리 코드를 직접 구현할 필요가 없습니다.
2. **`det_size` 파라미터를 통한 속도-정밀도 Trade-off 조절**
`app.prepare(det_size=(640, 640))`의 `det_size`는 Detector가 실제로 들여다보는 입력 해상도입니다. 이 값을 줄이면 **처리 속도(FPS)가 급격히 상승**하지만, 원본에서 몇십 픽셀밖에 안 되던 작은 얼굴(Small Face)은 리사이즈 과정에서 더 뭉개져 검출되지 않습니다. 반대로 값을 키우면 CCTV처럼 인물이 멀리 잡히는 환경에서 검출률이 올라갑니다. **원본 해상도가 아니라 이 값이 "몇 픽셀짜리 얼굴까지 잡을 것인가"를 결정한다**는 점이 실무에서 자주 놓치는 지점입니다.
3. **Confidence Score 기반 필터링**
반환되는 Bounding Box의 마지막 인덱스(`score`)를 이용해, 노이즈나 잘못 검출된 이미지 영역을 1차적으로 걸러내는 Thresholding 작업을 손쉽게 적용할 수 있습니다.
4. **모듈 교체(Decoupling) 가능성**
InsightFace의 Alignment 및 Embedder 모듈은 **(1) Bounding Box 좌표**와 **(2) 5개 Keypoint 좌표**만 넘겨주면 정상 작동합니다. 따라서 속도가 최우선인 실시간 관제 시스템이라면 Detector만 **YOLOv8-Face**나 **TensorRT 기반 커스텀 Detector**로 교체하여 파이프라인 전체 속도를 끌어올리는 식의 파이프라인 개조가 가능합니다.

### (2) Embedder 및 Alignment 모듈

InsightFace의 기본 Embedder로는 주로 **ArcFace 계열 모델**이 사용됩니다. ArcFace 내부의 `get` 메서드를 살펴보면, 특징(Feature) 추출 전에 정렬(Alignment) 과정이 어떻게 진행되는지 한눈에 볼 수 있습니다.

```python
# insightface/model_zoo/arcface_onnx.py

def get(self, img, face):
    # 1. Detector가 찾은 5개 Landmark(face.kps)를 이용해 얼굴 이미지 정렬 및 Crop
    aimg = face_align.norm_crop(img, landmark=face.kps, image_size=self.input_size[0])
    
    # 2. 정렬된 패치 이미지(aimg)로부터 512차원 특징 벡터 추출 후 평탄화(Flatten)
    face.embedding = self.get_feat(aimg).flatten()
    return face.embedding
```

Detector가 전달한 `face.kps`(5개 랜드마크 좌표)를 활용해 원본 이미지(`img`)에서 정규화된 얼굴 패치로 잘라내고 정렬(align)하는 함수가 바로 `face_align.norm_crop`입니다.

InsightFace 소스코드를 통해 이 정렬 과정이 어떻게 수학적으로 동작하는지 자세히 살펴보겠습니다.

```python
# insightface/utils/face_align.py

# ArcFace 표준 5개 랜드마크 템플릿 좌표 (112x112 캔버스 기준)
arcface_dst = np.array(
    [[38.2946, 51.6963],   # 왼쪽 눈
     [73.5318, 51.5014],   # 오른쪽 눈
     [56.0252, 71.7366],   # 코 끝
     [41.5493, 92.3655],   # 왼쪽 입꼬리
     [70.7299, 92.2041]],  # 오른쪽 입꼬리
    dtype=np.float32)

def estimate_norm(lmk, image_size=112, mode='arcface'):
    assert lmk.shape == (5, 2)
    assert image_size % 112 == 0 or image_size % 128 == 0
    
    # 입력 타겟 이미지 크기에 맞는 비율(Ratio) 계산
    if image_size % 112 == 0:
        ratio = float(image_size) / 112.0
        diff_x = 0
    else:
        ratio = float(image_size) / 128.0
        diff_x = 8.0 * ratio
        
    dst = arcface_dst * ratio
    dst[:, 0] += diff_x
    
    # 5개 Keypoint에서 타겟 좌표(dst)로 변환하는 Similarity Transform 행렬 추정
    tform = trans.SimilarityTransform()
    tform.estimate(lmk, dst)
    M = tform.params[0:2, :]  # warpAffine에 넘길 2x3 행렬 (내용은 유사 변환)
    return M

def norm_crop(img, landmark, image_size=112, mode='arcface'):
    # 1. 변환 행렬 M 추정
    M = estimate_norm(landmark, image_size, mode)
    # 2. Affine Warping 연산으로 회전, 크기 조절, Crop을 동시에 수행
    warped = cv2.warpAffine(img, M, (image_size, image_size), borderValue=0.0)
    return warped

```

#### 1. 표준 템플릿(`arcface_dst`)의 역할

`arcface_dst`는 $112 \times 112$ 픽셀 캔버스 위에 **양 눈, 코, 양 입꼬리가 놓여야 할 평균적인 위치**를 미리 고정해 둔 기준 좌표 배열입니다.

![](/images/face-recognition/landmark_coords.svg)
> 원본 얼굴 이미지를 변환해, 5개의 랜드마크가 $112 \times 112$ 캔버스 위 이 좌표들에 오도록 맞춥니다.

입력마다 얼굴의 위치와 각도가 제각각이면 모델은 매번 다른 기준으로 얼굴 특징을 읽어야 하고, 그만큼 정밀한 특징 추출이 어려워집니다. 표준 템플릿에 맞춰 정렬하면 다음과 같은 이점이 생깁니다.

* **기울기 정규화 (In-plane Normalization)**: 고개가 화면 안에서 기울어진 사진도 두 눈을 잇는 선이 수평이 되도록 세워집니다. 다만 좌우로 돌아간 고개(yaw)는 평면 회전으로 되돌릴 수 없어 이 단계로는 교정되지 않습니다. 옆얼굴은 정렬을 거쳐도 여전히 옆얼굴입니다.
* **스케일 정규화 (Scale Alignment)**: 카메라와의 거리에 상관없이 $112 \times 112$ 영역에서 눈·코·입이 차지하는 비율이 일정하게 유지됩니다.
* **특징 위치 고정 (Feature Localization)**: 모델이 "얼굴이 어디 있는지" 찾는 데 표현력을 쓸 필요 없이, **같은 자리에 놓인 이목구비의 생김새 차이**에만 집중해 512차원 벡터를 뽑을 수 있습니다.


#### 2. 변환 행렬 $M$ 추정과 유사 변환 (Similarity Transform)

`estimate_norm` 함수는 검출된 랜드마크(`lmk`)가 표준 템플릿(`dst`) 위치에 최대한 매핑되도록 만드는 $2 \times 3$ 크기의 변환 행렬 $M$을 추정합니다.

$$\begin{bmatrix} x' \\ y' \end{bmatrix} = \begin{bmatrix} a & b & e \\ c & d & f \end{bmatrix} \begin{bmatrix} x \\ y \\ 1 \end{bmatrix} = M \begin{bmatrix} x \\ y \\ 1 \end{bmatrix}$$

이때 범용적인 **아핀 변환(Affine Transform)** 대신 유사 변환(Similarity Transform)을 사용합니다.

> **아핀 변환(Affine Transform)이란?**
> 아핀 변환은 "직선은 변환 후에도 계속 직선으로 유지되고, 평행선은 변환 후에도 평행을 유지하는 변환"입니다.변환 과정에서 형태가 늘어나거나 기울어질 수는 있지만, 공간의 선형성(Linearity)이 유지된다는 특징이 있습니다.
> 아핀 변환으로 할 수 있는 4가지 기본 연산:
> - 이동 (Translation): $X, Y$ 축 방향으로 평행 이동
> - 회전 (Rotation): 특정 중심점을 기준으로 회전
> - 크기 조절 (Scaling): $X, Y$ 축 방향으로 확대 또는 축소
> - 전단 (Shearing): 한쪽 방향으로 빗겨지게 미끄러뜨림 (사각형을 평행사변형으로 변형)

> **유사 변환 (Similarity Transform)**
> - 유사 변환은 전단(Shear)을 허용하지 않고 [회전 + 크기 조절 + 평행 이동]만 허용합니다.
> - 얼굴의 본래 형태(비율)를 기형적으로 찌그러뜨리지 않고, 오직 **기울기 보정 + 중앙 맞춤 + 규격 확대/축소**만 수행하기 위해서입니다.


#### 3. Warping 연산을 통한 고속 전처리 (`norm_crop`)

`cv2.warpAffine` 단 한 번의 연산으로 [회전 보정 + 크기 조절 + 위치 이동 + 112x112 Crop]을 동시에 완료합니다.

따라서 별도로 `cv2.resize`나 이미지 슬라이싱을 거칠 필요가 없습니다.

다만 `cv2.warpAffine`은 기본적으로 **CPU 연산**이라는 점은 짚어둘 필요가 있습니다. 뒤의 **(3) 속도 최적화**에서 다루듯 이 전처리는 GPU 추론과 분리해 CPU에서 처리하는 편이 오히려 유리하고, OpenCV를 CUDA 지원으로 빌드한 환경이라면 `cv2.cuda.warpAffine`으로 GPU에 넘길 수도 있습니다.


#### 4. 임베딩 벡터 산출

여기까지가 앞서 본 `get` 메서드의 첫 줄(`norm_crop`)이 하는 일입니다. 정렬이 끝난 $112 \times 112$ 패치는 두 번째 줄의 `self.get_feat(aimg)`로 넘어가 512차원 벡터가 되고, `.flatten()`을 거쳐 `face.embedding`에 담깁니다. 이 벡터가 3절에서 코사인 유사도로 Gallery와 비교하던 바로 그 값입니다.

한 가지 덧붙이면, `face.embedding`은 **L2 정규화되지 않은 원본 벡터**입니다. InsightFace는 정규화된 버전을 `face.normed_embedding`으로 따로 제공하므로, 코사인 유사도를 계산할 때 직접 정규화하든 `normed_embedding`을 쓰든 **Gallery와 Probe 양쪽에서 같은 쪽을 골라야** 합니다.

### (3) 속도 최적화

InsightFace에서 기본 제공하는 `app.get()` 함수는 Detection부터 Alignment, Feature Extraction까지 단 한 줄로 처리할 수 있어 편리합니다. 하지만 **단일 이미지(Single Image)만 처리하도록 설계**되어 있기 때문에, 대용량 비디오 프레임이나 수많은 이미지를 분석할 때 **GPU의 병렬 처리 능력을 제대로 활용하지 못하는 성능 병목**이 발생합니다.

이러한 병목을 해결하려면 `app.get()`을 사용하는 대신, 내부 모듈을 직접 제어하여 **배치 처리(Batch Processing)** 파이프라인을 구축해야 합니다.

#### `get()`과 `forward()`의 내부 동작 방식 비교

ArcFace Embedder 모듈(`ArcFaceONNX`)의 내부 코드를 살펴보면 그 차이가 명확히 드러납니다.

```py
# insightface/model_zoo/arcface_onnx.py

class ArcFaceONNX:
    ...
    # 1. 단일 이미지 처리용 메서드 (CPU 연산 + GPU 연산이 혼재됨)
    def get(self, img, face):
        aimg = face_align.norm_crop(img, landmark=face.kps, image_size=self.input_size[0])
        face.embedding = self.get_feat(aimg).flatten()
        return face.embedding

    # 2. 배치 연산 전용 메서드 (ONNX/TensorRT GPU 가속 추론만 수행)
    def forward(self, batch_data):
        # batch_data: NCHW 형태의 Batch Tensor (N, C, H, W)
        blob = (batch_data - self.input_mean) / self.input_std
        net_out = self.session.run(self.output_names, {self.input_name: blob})[0]
        return net_out

```

#### 왜 `forward()` 메서드는 Alignment(Crop)를 내장하지 않을까?

`get()` 함수는 내부에서 OpenCV 기반의 `norm_crop`을 매번 실행하지만, `forward()` 메서드는 입력 데이터가 이미 정규화 및 정렬(Align)되어 있다고 가정합니다.

이는 연산 장치의 특성에 따른 **CPU와 GPU의 역할 분담 최적화** 때문입니다.

* **`norm_crop` (Alignment)**: NumPy 및 OpenCV 기반 연산으로 주로 **CPU**에서 빠르게 처리됩니다.
* **`forward` (Embedding)**: Deep Learning Tensor 연산으로 **GPU**에서 병렬 가속 연산으로 처리됩니다.

따라서 CPU에서 여러 얼굴의 `norm_crop`을 빠르게 수행한 뒤 배치 큐(Queue)에 쌓아두고, **GPU 연산이 가능한 적정 Batch Size가 채워졌을 때 `forward()`를 호출하는 것**이 GPU 사용률(Utilization)을 극대화하는 정석 구조입니다.

#### 비디오 고속 처리를 위한 배치 파이프라인 구현 예시

```python
import numpy as np
from insightface.app import FaceAnalysis
from insightface.utils import face_align

# Detection 모듈만 로드한다.
# 여기서 그냥 app.get()을 쓰면 프레임마다 Embedder가 이미 한 장씩 돌아버려
# 배치로 묶는 의미가 사라진다.
det_app = FaceAnalysis(name='buffalo_l', allowed_modules=['detection'])
det_app.prepare(ctx_id=0, det_size=(640, 640))

# 배치 처리 큐 및 설정
batch_queue = []
face_references = []  # 추후 결과를 개별 face 객체에 매핑하기 위한 리스트
BATCH_SIZE = 32

for frame in video_frames:
    faces = det_app.get(frame)  # bbox + kps만 채워진 Face 객체들
    for face in faces:
        # 1. CPU 연산: Alignment (112x112 Crop) 및 Tensor 변환 (HWC -> CHW)
        aimg = face_align.norm_crop(frame, face.kps, image_size=112)

        # get_feat()은 내부적으로 blobFromImages(swapRB=True)로 BGR -> RGB를 뒤집지만
        # forward()는 그 과정을 건너뛴다. 직접 맞춰 주지 않으면 채널 순서가 어긋난
        # 입력이 들어가 임베딩이 조용히 망가진다.
        rgb = aimg[:, :, ::-1]
        blob = np.transpose(rgb, (2, 0, 1))  # (112, 112, 3) -> (3, 112, 112)

        batch_queue.append(blob)
        face_references.append(face)

        # 2. GPU 연산: 배치 크기(BATCH_SIZE)가 채워지면 한 번에 GPU Forward
        if len(batch_queue) == BATCH_SIZE:
            batch_tensor = np.array(batch_queue, dtype=np.float32)
            embeddings = arcface_model.forward(batch_tensor)  # GPU 가속 추론
            
            # 추출된 벡터를 각 face 객체에 매핑
            for f, emb in zip(face_references, embeddings):
                f.embedding = emb.flatten()
                
            batch_queue.clear()
            face_references.clear()

# 남아있는 잔여 배치(Remainder Batch) 처리
if batch_queue:
    batch_tensor = np.array(batch_queue, dtype=np.float32)
    embeddings = arcface_model.forward(batch_tensor)
    for f, emb in zip(face_references, embeddings):
        f.embedding = emb.flatten()

```

> 💡 **성능 최적화 요약**
> 단순 루프 기반의 `get()` 호출을 **`norm_crop`(CPU)과 `forward`(GPU)로 분리한 배치 처리 방식**으로 개선하면, 영상 관제 시스템이나 대용량 DB 처리 시 **처리 속도(FPS)를 크게 끌어올릴 수 있습니다.**
> 다만 `get()`이 대신 해 주던 전처리(채널 순서 변환 등)를 직접 떠안게 되므로, 배치 파이프라인으로 바꾼 뒤에는 **같은 이미지를 `get()`과 배치 경로에 각각 넣어 임베딩이 일치하는지 반드시 검증**해야 합니다. 이 부분이 어긋나면 에러 없이 유사도만 조용히 낮아져 원인을 찾기 어렵습니다.

## 7. 커스텀 파이프라인 구축(모듈 교체) 시 고려사항

InsightFace 파이프라인(Detector, Alignment, Embedder)을 활용할 때, 특정 모듈만 원하는 AI 모델로 교체하고 싶은 경우가 존재합니다. 가장 흔한 케이스는 **Detector 모듈을 다른 SOTA 모델(예: YOLOv8-Face, MediaPipe 등)로 교체**하는 것입니다.

이때 기존 파이프라인과의 호환성을 위해 **반드시 확인해야 할 핵심 포인트 2가지**가 있습니다.

### 모듈 교체 시 체크리스트

#### 1. Landmark(5 Keypoints) 반환 여부

새로운 Detector가 바운딩 박스(`bbox`) 외에 랜드마크 좌표를 제공하지 않는다면, 앞서 살펴본 `norm_crop`(Alignment) 연산을 수행할 수 없습니다.

* **해결책**: 랜드마크를 출력하지 않는 단순 Detector(예: 범용 YOLO)를 사용할 경우, **별도의 Landmark 추정 모델(예: Dlib, FAN 등)을 추가로 연결**하여 (양 눈, 코, 양 입꼬리) 5개 좌표를 추출한 뒤 Embedder의 입력값(`face.kps`)으로 넘겨주어야 합니다.

#### 2. Landmark 좌표의 순서 및 정의 매핑

Detector나 Landmark 모델마다 반환하는 Keypoint의 순서와 기준 위치가 서로 다릅니다. InsightFace의 ArcFace Alignment 연산은 반드시 아래 순서의 5개 좌표(Shape: `[5, 2]`)를 입력받도록 설계되어 있습니다.

1. **왼쪽 눈 (Left Eye)**
2. **오른쪽 눈 (Right Eye)**
3. **코 끝 (Nose)**
4. **왼쪽 입꼬리 (Left Mouth Corner)**
5. **오른쪽 입꼬리 (Right Mouth Corner)**

여기서 좌/우는 **인물 기준이 아니라 이미지 기준**입니다. 화면에서 더 왼쪽(x 좌표가 작은 쪽)에 보이는 눈이 1번이며, 이는 앞서 본 `arcface_dst` 템플릿에서 첫 번째 좌표의 $x$(38.29)가 두 번째 좌표의 $x$(73.53)보다 작다는 점과 대응합니다. 이 기준을 인물 기준으로 착각해 1·2번을 바꿔 넣으면 얼굴이 좌우로 뒤집힌 채 정렬되어, **에러 없이 유사도만 떨어지는** 형태로 문제가 드러납니다.

> ⚠️ **주의**: 만약 사용하려는 모델이 랜드마크 68개를 출력하거나 순서가 다를 경우(예: MediaPipe, Dlib 등), **인덱스 슬라이싱이나 매핑 로직을 통해 InsightFace 규격(순서 및 5개 좌표)에 맞게 재배열**해 주어야 정상적인 Alignment 및 Embedding 추출이 가능합니다.

> 💡 **Detector 모델을 교체하는 이유**
> InsightFace의 기본 Detection 모델(SCRFD 등)도 매우 훌륭하지만 YOLO 계열이 TensorRT 연동 등 GPU 추론 연산 효율에서 더 유리한 경우가 존재합니다.
> 이와 또다른 이유로 엣지 환경에서는 제약된 환경으로 인해 모바일 기기와 같은 엣지 환경에서 최적화된 [MediaPipe](https://github.com/google-ai-edge/mediapipe)의 모델들을 이용하기도 합니다.

## 8. 필수 원칙 — Gallery와 Probe 파이프라인은 100% 일치해야 한다

실무에서 시스템을 구축할 때 가장 흔히 범하는 실수 중 하나는 **Gallery(등록 DB)** 사진을 만드는 파이프라인과 현장에서 실시간 처리하는 **Probe(조회)** 파이프라인을 다르게 구성하는 것입니다.

> ⚠️ **핵심 원칙**: Gallery에 얼굴 벡터(Embedding)를 등록할 때 사용한 **Detector, Alignment 기준(템플릿), Embedder 모델 등**은 현장에서 Probe 특징을 추출할 때의 파이프라인과 **완벽히 동일**해야 합니다.

### 파이프라인이 불일치할 때 발생하는 문제

만약 Gallery 등록 시에는 A 모델(예: FaceNet + Dlib Align)을 쓰고, 현장 Probe 검색 시에는 B 모델(예: ArcFace + InsightFace Align)을 사용하는 등 파이프라인이 일치하지 않을 경우 다음과 같은 심각한 문제가 발생합니다.

1. **동일인 미인식 (False Negative):**
동일인의 얼굴이 맞더라도, Alignment 템플릿의 미세한 차이나 Embedder 모델의 Feature Space 분포가 달라 벡터 간 유사도가 낮게 측정되어 **인식 실패**로 이어집니다.
2. **타인 오인식 (False Positive):**
벡터의 차원 축 및 정규화 기준이 달라져, 전혀 다른 사람의 임베딩 벡터와 우연히 높은 유사도 점수를 형성하는 **오인식 보안 사고**가 발생할 수 있습니다.

따라서 임베더 모델 업데이트나 파이프라인 변경(Detector 교체, Alignment 템플릿 변경 등)이 일어나면, **기존 Gallery DB에 저장되어 있던 모든 인물의 임베딩 벡터도 새 파이프라인으로 다시 추출(Re-indexing)해야 합니다.** 이때 3절에서 잡아 둔 임계값 역시 새 임베딩 공간 기준으로 다시 튜닝해야 합니다. 모델 교체 비용은 모델을 내려받는 시간이 아니라, **Gallery 전체를 다시 인덱싱하고 임계값을 다시 잡는 시간**이라는 점을 미리 계산에 넣어 두는 편이 좋습니다.

---

**출처 및 참고**

- Mei Wang, Weihong Deng, [Deep Face Recognition: A Survey (arXiv:1804.06655)](https://arxiv.org/abs/1804.06655), 2018 — 4절 Face Recognition Pipeline의 3단계 구성(Detection → Alignment → Representation)은 이 논문 pp. 2\~3의 정리를 따랐습니다. *"First, a face detector is used to localize faces in images or videos. Second, with the facial landmark detector, the faces are aligned to normalized canonical coordinates. Third, the FR module is implemented with these aligned face images. We only focus on the FR module throughout the remainder of this paper."*
- Jiankang Deng, Jia Guo, Jing Yang, Niannan Xue, Irene Kotsia, Stefanos Zafeiriou, [ArcFace: Additive Angular Margin Loss for Deep Face Recognition (arXiv:1801.07698)](https://arxiv.org/abs/1801.07698), CVPR 2019 — 5절에서 표준으로 언급한 ArcFace 원 논문. 112×112로 정렬된 얼굴 패치를 입력으로 학습한다는 4절 참고 박스의 근거
- [deepinsight/insightface (GitHub)](https://github.com/deepinsight/insightface) — 5\~6절의 `FaceAnalysis` 파이프라인 구현체. 라이선스 정책은 저장소 README의 License 항목 기준으로, **코드는 MIT(학술·상업 이용 제한 없음)** 이지만 **학습 데이터와 그 데이터로 학습된 모델은 비상업적 연구 목적으로만** 배포됩니다(GitHub 수동 다운로드와 python 라이브러리 자동 다운로드 모두 동일). 2025-11-24 업데이트 기준 `buffalo_l` 등 오픈소스 얼굴 인식 모델의 상업적 이용은 별도 라이선스 문의가 필요합니다
- [fal/AuraFace-v1 (Hugging Face)](https://huggingface.co/fal/AuraFace-v1) — 5절에서 대안으로 제시한 ArcFace 계열 임베더. InsightFace 라이브러리의 모델 디렉터리만 교체해 그대로 사용할 수 있습니다
- [google-ai-edge/mediapipe (GitHub)](https://github.com/google-ai-edge/mediapipe) — 4·7절에서 언급한 엣지·모바일 환경용 Face Detection / Face Landmark 솔루션. 반환하는 랜드마크의 개수와 순서가 ArcFace 규격(5점)과 다르므로, Embedder에 넘기기 전 인덱스 매핑이 필요합니다
