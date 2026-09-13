---
title: "Smart CCTV, 얼굴이 보이지 않는 구간은 누구인가"
date: 2026-09-12
category: ai
summary: 얼굴만으로 매 프레임을 식별하려는 구조의 한계를 짚고, 전신 추적(MOT)으로 궤적을 먼저 이어 붙인 뒤 그 궤적에 신원을 붙이는 방식을 정리합니다. MOT의 여섯 가지 오류 유형과 ID Switch, Kalman Filter와 Re-ID 모듈의 역할 분담, 얼굴 프레임을 고르는 품질 게이트(FIQA), 프레임별 판단을 궤적 하나의 결론으로 합치는 결합 규칙과 미등록 인물 처리까지 다룹니다.
tags: ["Smart CCTV", "Multi-Object Tracking", "Face Recognition", "Re-ID", "Computer Vision"]
---

> **TL;DR**
>
> 얼굴은 **매 프레임마다 얻을 수 있는 정보가 아닙니다.** 거리·각도·역광·뒷모습 때문에 한 사람이 화면에 머무는 내내 얼굴이 쓸모 있는 구간은 일부뿐입니다. 그래서 순서를 뒤집습니다. **전신 추적(MOT)으로 궤적을 먼저 이어 붙이고, 그 궤적 안에서 쓸 만한 얼굴만 모아 Gallery와 대조한 뒤, 결과를 궤적 전체에 붙입니다.**
>
> 대가도 분명합니다. 프레임당 연산이 늘고, 프레임 하나에서 끝나던 오류가 **궤적 전체로 번집니다(ID Switch).** Kalman Filter는 "어디로 움직일지"로 후보를 좁히고 Re-ID 모듈은 "어떻게 생겼는지"로 검증하지만, Re-ID가 보는 것은 사실상 옷과 체형이라 옷이 바뀌거나 오래 사라졌다 돌아오면 같은 사람에게 새 ID가 붙습니다. 이 구멍을 메우는 것이 **외부 Gallery DB와의 얼굴 매칭**입니다.
>
> 그러려면 두 가지를 더 정해야 합니다. **어떤 얼굴을 물어볼 것인가**, **여러 프레임의 답을 어떻게 합칠 것인가**.

Smart CCTV 시스템을 만들 때, 사람들의 얼굴이 잘 찍히도록 설치를 해도 어쩔수 없이 거리가 멀어지는 경우도 존재하고 사람들의 키가 모두 달라서 얼굴 각도가 달라지기도 합니다. 또한 카메라를 등지는 경우 소프트웨어로 얼굴 인식 기술을 아무리 개선해도 화면에 얼굴이 나오지 않기 때문에 애초에 인식하기 불가능합니다.

예를 들어 같은 인물들이 카메라 쪽으로 걸어오는 장면을 세 구간으로 끊어서 **얼굴 영역만** 검출하고, 검출된 얼굴을 등록 DB와 대조한 유사도를 box 위에 적어보면 이 제약이 그대로 드러납니다.

<div style="display:flex;gap:0.6rem;align-items:flex-start;flex-wrap:wrap;margin:1.5rem 0;"><figure style="flex:1 1 210px;margin:0;"><a href="/images/smart-cctv-tracking/face-detection-001.png" target="_blank" rel="noopener" style="border-bottom:none;"><img src="/images/smart-cctv-tracking/face-detection-001.png" alt="역광을 받아 실루엣처럼 어둡게 보이는 원경 장면. 네 사람의 머리에 작은 주황색 얼굴 bounding box가 하나씩 있고, 각 box 위에 회색 라벨로 ??? 14%, ??? 9%, ??? 17%, ??? 11%가 적혀 있다" style="width:100%;margin:0;"></a><figcaption style="font-size:0.82rem;color:#666;margin-top:0.5rem;line-height:1.5;">① 원경·역광 — 얼굴 box는 네 명 모두 잡혔지만 유사도가 10%대에 머물러 전부 "???"</figcaption></figure><figure style="flex:1 1 210px;margin:0;"><a href="/images/smart-cctv-tracking/face-detection-002.png" target="_blank" rel="noopener" style="border-bottom:none;"><img src="/images/smart-cctv-tracking/face-detection-002.png" alt="인물들이 가까워져 옷과 이목구비가 또렷하게 보이는 중거리 장면. 네 사람의 얼굴 bounding box 위에 주황색 라벨로 Zoro 71%, Luffy 65%, Sanji 68%, Usopp 63%가 적혀 있다" style="width:100%;margin:0;"></a><figcaption style="font-size:0.82rem;color:#666;margin-top:0.5rem;line-height:1.5;">② 적정 거리 — 네 명 모두 60~70%대로 등록 DB와 매칭</figcaption></figure><figure style="flex:1 1 210px;margin:0;"><a href="/images/smart-cctv-tracking/face-detection-003.png" target="_blank" rel="noopener" style="border-bottom:none;"><img src="/images/smart-cctv-tracking/face-detection-003.png" alt="인물들이 더 가까이 다가와 상체가 화면을 가득 채운 근접 장면. 세 사람의 얼굴 box에는 Zoro 84%, Luffy 81%, Usopp 79% 라벨이 붙어 있지만, 키가 커서 머리가 화면 위로 잘려 나간 정장 차림 인물은 회색 ??? 13% 라벨이 붙어 있다" style="width:100%;margin:0;"></a><figcaption style="font-size:0.82rem;color:#666;margin-top:0.5rem;line-height:1.5;">③ 근접 — 세 명은 80%대로 올라가지만, 머리가 프레임 위로 잘린 인물은 다시 "???"</figcaption></figure></div>

*프라이버시 보호를 위해 실제 CCTV 영상이 아닌 애니메이션 장면으로 치환했습니다. 유사도 수치는 실제 모델 추론 결과가 아니라 설명을 위한 예시입니다*

세 장면을 이어보면, 한 사람이 화면에 머무는 내내 얼굴이 쓸모 있는 구간은 **②처럼 거리·각도·조명이 맞아떨어지는 일부 구간뿐**입니다. ①에서는 얼굴이 "있다"까지만 알 수 있고, ③에서는 같은 사람이 분명히 화면 안에 있는데도 얼굴 기준으로는 그 순간 존재가 사라집니다. 이와 같은 여러가지 제약사항으로 얼굴 인식 기술만으로는 영상에 존재하는 모든 프레임에 대해 각 사람들을 인식하여 분석하기에는 현실적으로 불가능합니다.

## 사람은 어떻게 사람을 계속 알아보는가

여기서 관점을 바꿔서 AI가 아니라 사람의 관점에서 우리는 각 사람들을 어떻게 연속적으로 인식할까요? 일단 기본적으로는 사람 얼굴을 통해서 각 사람들을 식별합니다. 여기서 중요한 점으로는 사람은 한 번 해당 사람을 얼굴을 통해서 인식한 이후에는 그 사람의 전체적인 특징들을 통해서 자연스럽게 각 사람들을 분리합니다. 예를 들어 약속 장소에서 친구가 오기를 기다린 경험이 있을 것입니다. 이 때 많은 인파 속에서 우리는 친구를 잘 찾지 못하다가 친구의 얼굴이 보이는 순간 친구의 위치를 인식하게됩니다. 그 이후에는 자연스레 친구가 오늘 입고온 옷이나 악세서리, 걸음거리 그리고 기타 특징들을 통해서 친구의 전체적인 외형을 머리속에 인지하게 됩니다. 이 전체적인 특징을 파악한 이후에는 친구가 나를 등져서 얼굴이 보이지 않아도 아까 미리 훑어봤던 전체적인 특징들을 통해 친구의 위치를 바로 식별하게 됩니다. 물론 다음 날 다시 만났을 때는 친구의 옷이나 악세서리가 바뀌어서 또다시 전체적인 외형을 다시 머리속에 인지하는 과정을 거치게 됩니다.

이를 AI 시스템에도 적용하면 얼굴은 해당 인물을 처음에 식별할 때 매우 중요하지만 그 이후부터는 전체적인 특성들(옷차림, 헤어 스타일 등)을 통해서 해당 인물을 식별할 수 있기 때문에 경우에 따라서는 얼굴이 필수적으로 필요하지는 않게 됩니다. AI task에서는 이렇게 특정 객체(또는 인물)의 전체적인 특성을 이용하여 비디오 영상 속에서 지속적으로 해당 객체의 위치를 추적하는 task가 존재하는데 Object Tracking이라고 하고 다양한 객체가 영상 속에서 존재하고 이를 추적하는 경우 Multi Object Tracking(MOT)라고 부릅니다.

앞의 세 장면을 이번에는 얼굴이 아니라 **인물 전체**를 기준으로 다시 보겠습니다.

<div style="display:flex;gap:0.6rem;align-items:flex-start;flex-wrap:wrap;margin:1.5rem 0;"><figure style="flex:1 1 210px;margin:0;"><a href="/images/smart-cctv-tracking/tracking-001.png" target="_blank" rel="noopener" style="border-bottom:none;"><img src="/images/smart-cctv-tracking/tracking-001.png" alt="앞서 나온 역광 원경 장면과 동일한 구도. 얼굴이 아니라 네 사람의 몸 전체를 감싸는 세로로 긴 주황색 bounding box가 그려져 있고, 각 box 위에 id-001부터 id-004까지 라벨이 붙어 있다" style="width:100%;margin:0;"></a><figcaption style="font-size:0.82rem;color:#666;margin-top:0.5rem;line-height:1.5;">① 실루엣만 보여도 네 개의 궤적이 모두 유지됩니다</figcaption></figure><figure style="flex:1 1 210px;margin:0;"><a href="/images/smart-cctv-tracking/tracking-002.png" target="_blank" rel="noopener" style="border-bottom:none;"><img src="/images/smart-cctv-tracking/tracking-002.png" alt="앞서 나온 중거리 장면과 동일한 구도. 네 사람의 몸 전체를 감싸는 세로로 긴 주황색 bounding box에 id-001부터 id-004까지 라벨이 붙어 있고, 각 인물의 옷차림이 box 안에 뚜렷하게 담겨 있다" style="width:100%;margin:0;"></a><figcaption style="font-size:0.82rem;color:#666;margin-top:0.5rem;line-height:1.5;">② 옷차림·체형이 또렷해져도 ID는 ①과 동일하게 이어집니다</figcaption></figure><figure style="flex:1 1 210px;margin:0;"><a href="/images/smart-cctv-tracking/tracking-003.png" target="_blank" rel="noopener" style="border-bottom:none;"><img src="/images/smart-cctv-tracking/tracking-003.png" alt="앞서 나온 근접 장면과 동일한 구도. 얼굴 검출에서 ???로 남았던 정장 차림 인물을 포함해 네 사람 모두 몸 전체를 감싸는 주황색 bounding box와 id-001부터 id-004까지의 라벨을 유지하고 있다" style="width:100%;margin:0;"></a><figcaption style="font-size:0.82rem;color:#666;margin-top:0.5rem;line-height:1.5;">③ 얼굴이 잘려 나간 id-003도 끊김 없이 유지됩니다</figcaption></figure></div>

얼굴 기준에서는 ②에서만 온전했던 정보가, 인물 전체 기준에서는 ①·②·③ 모두에서 유지됩니다. 즉 **화면에 계속 이어지는 선을 만드는 일은 얼굴이 아니라 전신 추적이 담당**합니다.

## 궤적이 먼저, 신원은 나중에

여기서 일반적으로 Multi Object Tracking은 우리처럼 얼굴을 통해서 특정 인물을 누구라고 식별하는 것은 아니고 각 객체에 대해 임의의 ID를 부여하는 형식입니다. 위 그림의 `id-001` \~ `id-004`가 바로 그 임의의 ID입니다. 이 단계에서 얻은 것은 "네 사람이 각각 끊기지 않고 이어져 있다"는 사실뿐이고, 그 궤적이 현실의 누구인지는 아직 비어 있습니다. 이 빈칸을 채워주는 것이 미리 등록해 둔 얼굴 DB(Gallery)입니다.

<div style="display:flex;gap:0.75rem;flex-wrap:wrap;margin:1.5rem 0;"><img src="/images/smart-cctv-tracking/zoro-gallery.png" alt="초록색 머리에 금색 귀걸이를 한 인물의 정면 얼굴 crop" style="flex:1 1 120px;min-width:110px;max-width:180px;margin:0;"><img src="/images/smart-cctv-tracking/luffy-gallery.png" alt="검은 단발 머리에 얼굴에 흉터가 있는 인물의 정면 얼굴 crop" style="flex:1 1 120px;min-width:110px;max-width:180px;margin:0;"><img src="/images/smart-cctv-tracking/sanji-gallery.png" alt="금발 앞머리가 한쪽 눈을 덮은 인물의 정면 얼굴 crop" style="flex:1 1 120px;min-width:110px;max-width:180px;margin:0;"><img src="/images/smart-cctv-tracking/usopp-gallery.png" alt="곱슬머리에 그물 모양 두건을 쓴 인물의 정면 얼굴 crop" style="flex:1 1 120px;min-width:110px;max-width:180px;margin:0;"></div>

*미리 등록해 둔 Gallery. 통제된 조건에서 잘 찍힌 얼굴이 한 장만 있어도 시작할 수 있고, 각도·조명이 다른 여러 장을 등록해 두면 매칭이 더 안정적입니다*

이제 순서를 뒤집습니다. 매 프레임마다 얼굴로 사람을 구별하는 것이 아니라, **전신 추적으로 먼저 궤적을 이어 붙이고, 그 궤적에 속한 프레임들 중 얼굴이 잡힌 것만 모아서 Gallery와 매칭한 뒤, 그 결과를 궤적 전체에 되돌려 붙이는** 방식입니다.

- `id-001` → ②에서 `Zoro 71%`, ③에서 `Zoro 84%` → **Zoro**
- `id-002` → ②에서 `Luffy 65%`, ③에서 `Luffy 81%` → **Luffy**
- `id-003` → ②에서 `Sanji 68%` (①·③은 `???`) → **Sanji**
- `id-004` → ②에서 `Usopp 63%`, ③에서 `Usopp 79%` → **Usopp**

이렇게 하면 앞에서 아무것도 하지 못했던 ① 프레임이 되살아납니다. ①은 역광 때문에 얼굴만으로는 네 명 모두 `???`였지만, 같은 궤적에 묶인 ②·③ 프레임이 Gallery와 매칭되는 순간 그 신원이 궤적을 타고 ①까지 소급 적용되어 **①의 네 사람도 각각 Zoro·Luffy·Sanji·Usopp으로 식별**됩니다. `id-003`은 더 극적입니다. ①에서도 ③에서도 얼굴이 `???`였지만, 얼굴이 잡힌 ② 구간의 근거가 Sanji 쪽으로 모이면서 **궤적 전체의 신원이 Sanji로 확정**됩니다.

정리하면 얼굴은 **매 프레임마다 필요한 정보가 아닙니다.** 하나의 궤적 안에서 "이 사람이 누구다"라고 말할 만큼의 근거가 모이는 순간, 그때까지 확실하지 않았던 나머지 프레임들의 신원까지 함께 확정됩니다. 그래서 질문은 "얼굴이 몇 번 잡혔는가"가 아니라 **어느 정도의 근거가 모여야 확신이라고 부를 수 있는가**로 옮겨 갑니다. 이 질문은 뒤의 「Track에 어떤 person_id를 붙일 것인가」에서 다시 다룹니다.

> **참고 — 실시간 분석에서는 소급 적용이 제한됩니다.**
> 궤적 전체에 신원을 되돌려 붙이는 것은 궤적이 끝난 뒤 한 번에 처리할 수 있을 때, 즉 배치·사후 분석에서 가능한 이야기입니다. 프레임이 들어오는 즉시 결과를 내보내야 하는 실시간 인식에서는 Track 단위로 모아서 판정하는 방식을 그대로 쓸 수 없습니다. 신원이 확정되는 시점 **이후의 프레임(Future Frame)에만** 라벨이 적용되고, 그 이전 구간은 미확정 상태로 남거나 사후 보정에 맡겨집니다.
> 확정을 앞당기려고 근거를 적게 모으면 오판 위험이 커지므로, 실시간 시스템에서는 **얼마나 빨리 확정할 것인가와 얼마나 확실하게 확정할 것인가 사이의 지연–정확도 트레이드오프**가 따로 생깁니다.

한 가지 덧붙이면, "그 궤적에 속한 얼굴"을 어떻게 알아내는지 — 즉 검출된 얼굴 box를 어느 전신 track에 귀속시킬 것인지 — 는 그 자체로 별도의 문제입니다. 인물이 겹치는 순간 얼굴이 엉뚱한 track에 붙으면 그 뒤의 모든 단계가 무너지기 때문입니다. 이 글에서는 **얼굴과 track의 연결은 이미 되어 있다고 보고** 그다음 단계를 다루고, 연결 방법 자체는 별도의 글에서 정리할 예정입니다.

## MOT 정의

> 이 절의 정의와 표기는 Momir Adžemović, [*Deep Learning-Based Multi-Object Tracking: A Comprehensive Survey from Foundations to State-of-the-Art*](https://arxiv.org/abs/2506.13457) (arXiv:2506.13457, 2025)의 **§3.1 Problem Formulation**을 따랐습니다.

다중 객체 추적(Multi-Object Tracking, MOT)은 이산 시간 $\{1, 2, \dots, T\}$ 동안 비디오에 등장하는 관심 객체 집합 $K$의 **식별자(ID)를 시간에 따라 이어가는 작업**입니다.

시점 $t$에서 화면에 보이는 객체들의 집합 $X_t$는 다음과 같이 정의됩니다.

$$X_t = \{x_t^k \mid k \in K_t\}$$

여기서 $x_t^k$는 시점 $t$에서 식별자 $k$를 가진 객체의 정답 데이터(Ground Truth)이고, $K_t \subseteq K$는 시점 $t$에 시야에 들어와 있는 객체들의 집합입니다. 객체는 장면에 진입하거나 이탈할 수 있고 나갔다가 다시 돌아올 수도 있으므로, $K_t$는 시간에 따라 변합니다.

MOT의 목표는 **비디오에 등장하는 모든 객체의 궤적(Trajectory)을 계산하는 것**입니다. 식별자 $k$의 객체가 관측된 시점들의 집합을 $T_k$라고 할 때, 그 객체의 궤적 $\tau^k$는 다음과 같습니다.

$$\tau^k = \{x_t^k \mid t \in T_k\}$$

객체가 중간에 가려지거나(Occlusion) 시야 밖으로 나가면 궤적 $\tau^k$는 끊어지거나 파편화(Fragmented)될 수 있습니다. 앞의 예시에서는 네 사람 모두 ①\~③ 내내 화면 안에 머물렀기 때문에 네 개의 궤적이 끊기지 않고 유지된 경우에 해당합니다.

비디오 전체의 정답 궤적 집합 $\tau$는 개별 궤적을 모두 모은 것입니다.

$$\tau = \{\tau^k \mid k \in K\}$$

MOT 추적기(Tracker)는 예측한 궤적 집합 $\hat{\tau}$가 정답 $\tau$에 최대한 가까워지도록 만드는 알고리즘입니다. 이때 $\hat{\tau}^k$는 예측된 궤적을, $\hat{x}_t^k$는 예측된 검출(Detection) 결과를 의미합니다.

### 추적기 출력은 어떻게 생겼는가

위 정의를 실제 추적기의 출력 형태로 옮기면 대략 다음과 같습니다. 앞의 ①·②·③ 세 장면을 각각 하나의 프레임으로 보고, 그림에 그려진 box를 `[x, y, w, h]`로 옮겼습니다.

```json
[
  {
    "track_id": "id-001",
    "class": "person",
    "trajectory": [
      { "frame_id": 1, "bbox": [371, 173,  86, 202] },
      { "frame_id": 2, "bbox": [261,  13, 151, 352] },
      { "frame_id": 3, "bbox": [181,   0, 161, 360] }
    ]
  },
  {
    "track_id": "id-002",
    "class": "person",
    "trajectory": [
      { "frame_id": 1, "bbox": [459, 183,  63, 192] },
      { "frame_id": 2, "bbox": [406,  32, 101, 334] },
      { "frame_id": 3, "bbox": [349,   0, 113, 360] }
    ]
  },
  {
    "track_id": "id-003",
    "class": "person",
    "trajectory": [
      { "frame_id": 1, "bbox": [535, 172,  67, 203] },
      { "frame_id": 2, "bbox": [531,   6, 106, 360] },
      { "frame_id": 3, "bbox": [492,   0, 114, 360] }
    ]
  },
  {
    "track_id": "id-004",
    "class": "person",
    "trajectory": [
      { "frame_id": 1, "bbox": [621, 183,  68, 192] },
      { "frame_id": 2, "bbox": [675,  38, 116, 329] },
      { "frame_id": 3, "bbox": [654,   0, 128, 360] }
    ]
  }
]
```

여기서 눈여겨볼 점은 **어느 필드에도 "Zoro"나 "Luffy"가 없다**는 것입니다. 일반적인 MOT 모델이 내놓는 것은 `class`(e.g., person, car)와 `track_id`(몇 번째 궤적인지)까지이고, `id-001`이 현실의 누구인지는 비어 있습니다. 앞에서 이야기한 Gallery 매칭은 바로 이 출력에 `person_id` 같은 필드를 한 칸 더 채워 넣는 작업입니다.

## MOT는 어떤 식으로 틀리는가

MOT 시스템 역시 모든 인물을 완벽하게 추적하지는 못합니다. 추적 결과가 어떤 형태로 어긋나는지를 유형별로 알아두면 나중에 문제를 분석하고 디버깅할 때 기준이 생기므로, 여섯 가지 경우를 먼저 정리하겠습니다.

![정답 track과 추론 track이 어긋나는 여섯 가지 경우를 (a)부터 (f)까지 나란히 그린 도식. 정답은 실선 원, 추론 결과는 점선 원으로 표시되어 있다](/images/smart-cctv-tracking/tracking-result-type.png)

*출처: Momir Adžemović, [Deep Learning-Based Multi-Object Tracking: A Comprehensive Survey from Foundations to State-of-the-Art (arXiv:2506.13457)](https://arxiv.org/abs/2506.13457), Fig. 2*

그림에서 **실선 원은 정답(Ground Truth) track**을, **점선 원은 tracker가 추론한 track**을 뜻합니다. (a)·(d)·(e)·(f)처럼 정답과 추론이 서로 대응되는 경우를 보면 둘이 픽셀 단위로 딱 맞지는 않는데, 이 어긋남 자체가 위치 오차(Localization Error)입니다.

- **(a)** 정답 track과 추론 track이 모든 시점에서 대응되는 경우입니다. bbox가 완벽히 겹치는 일은 거의 없어 그림에서도 약간 어긋나 있지만, 전체적으로는 준수한 결과입니다.
- **(b)** 정답 track이 없는데 추론 track만 있는 경우입니다 (False Positive Track).
- **(c)** 반대로 정답 track은 있는데 tracker가 아예 잡지 못한 경우입니다 (False Negative Track).
- **(d)** track 자체는 맞게 잡았지만, 정답에는 detection이 3개인데 추론에는 4개가 있는 경우입니다. 정답에 없는 detection이 하나 더 붙었으므로 False Positive Detection입니다.
- **(e)** 반대로 정답에는 detection이 4개인데 추론에는 3개만 있는 경우입니다. 추론이 하나를 놓쳤으므로 False Negative Detection입니다.
- **(f)** 두 track이 처음에는 제대로 대응되다가 중간에 서로 신원이 뒤바뀌는 경우입니다 (ID Switch). 앞의 예시로 치면 `id-001`과 `id-002`가 교차하는 순간 Zoro와 Luffy가 맞바뀌는 상황입니다. 주로 인물이 앞뒤로 겹치거나 갑자기 방향을 바꿀 때 발생합니다.

이 중 **(f) ID Switch가 MOT에서 가장 치명적인 error type**입니다. (b)\~(e)는 한 프레임이나 한 구간의 손실로 끝나지만, ID Switch는 그 이후의 궤적 전체를 다른 사람의 것으로 만들어 버리기 때문입니다. 게다가 검출 중심 지표(MOTA)에서는 ID Switch 횟수가 FP·FN 개수에 비해 훨씬 작아 잘 드러나지 않습니다. 그래서 신원을 얼마나 일관되게 유지했는지를 직접 보는 **IDF1** 같은 identity-aware 지표를 함께 보고하는 것이 관례입니다.

## Face Detector만 쓸 때와 MOT를 함께 쓸 때

이 error type들을 알고 나면, 얼굴만으로 만든 Smart CCTV와 MOT를 얹은 Smart CCTV의 장단점이 뚜렷하게 갈립니다.

<div style="overflow-x:auto;margin:1.5rem 0;">
<table style="width:100%;border-collapse:collapse;font-size:0.88rem;">
<thead><tr>
<th style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;text-align:left;background:#f5f5f5;white-space:normal;width:16%;">비교 항목</th>
<th style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;text-align:left;background:#f5f5f5;white-space:normal;width:42%;">Face Detector</th>
<th style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;text-align:left;background:#f5f5f5;white-space:normal;width:42%;">MOT + Face Detector</th>
</tr></thead>
<tbody>
<tr>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;"><strong>핵심 메커니즘</strong></td>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;">매 프레임 얼굴 bbox를 검출하고, 그 한 장의 임베딩을 Face DB와 1:N으로 직접 매칭</td>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;">MOT로 궤적을 먼저 만들고, 궤적 안의 주요 프레임별로 Face 임베딩을 모아 <strong>Track 단위</strong>로 Face DB와 매칭</td>
</tr>
<tr>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;background:#fafafa;"><strong>저화질·각도 변화</strong></td>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;background:#fafafa;"><strong>취약</strong> — 얼굴이 뭉개지거나 측면이면 유사도가 떨어져 미인식되거나 타인으로 오매칭</td>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;background:#fafafa;"><strong>강함</strong> — 궤적 안에서 얼굴이 잘 잡힌 프레임 몇 장만 확보되면 궤적 전체에 신원이 부여됨</td>
</tr>
<tr>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;"><strong>Occlusion<br>(가림·등짐)</strong></td>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;"><strong>식별 중단</strong> — 뒷모습·숙인 얼굴·마스크 등으로 얼굴이 사라지면 그 구간은 통째로 비어 있음</td>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;"><strong>연속성 유지</strong> — 얼굴이 안 보이는 구간도 전신 box로 궤적을 이어가고, 다시 얼굴이 보이면 그대로 복원</td>
</tr>
<tr>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;background:#fafafa;"><strong>오식별이 나타나는 방식</strong></td>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;background:#fafafa;"><strong>프레임 단위로 흔들림</strong> — 1초 안에 Luffy → Unknown → Zoro로 결과가 계속 바뀌는 핑퐁 현상</td>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;background:#fafafa;"><strong>궤적 단위로 오염</strong> — 위 (f) ID Switch가 나면 Zoro의 궤적에 Luffy의 신원이 끝까지 붙어 있게 됨</td>
</tr>
<tr>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;"><strong>연산 비용<br>(프레임당)</strong></td>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;"><strong>낮음</strong> — 얼굴 검출과 임베딩 추출만 수행해 Edge 기기에도 올릴 수 있음. 다만 원거리의 작은 얼굴까지 잡으려면 고해상도 입력이 필요해 그만큼 비용이 올라감</td>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;"><strong>높음</strong> — 인물 검출, Re-ID feature 추출, Kalman filter, 프레임 간 association이 매 프레임 추가됨. 대신 <strong>얼굴 임베딩은 선별된 일부 프레임에서만</strong> 돌리므로 그쪽 비용은 오히려 줄어듦</td>
</tr>
<tr>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;background:#fafafa;"><strong>Face DB 조회 횟수</strong></td>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;background:#fafafa;"><strong>많음 (프레임 단위)</strong> — 화면에 N명이 있으면 N × 프레임 수만큼 조회가 발생</td>
<td style="border:1px solid #e5e5e5;padding:0.6rem 0.8rem;vertical-align:top;white-space:normal;background:#fafafa;"><strong>적음 (궤적 단위)</strong> — 궤적당 대표 프레임에 대해서만 조회하므로 DB 부하가 크게 줄어듦</td>
</tr>
</tbody>
</table>
</div>

정리하면 MOT를 얹는 것은 공짜가 아닙니다. **프레임당 연산 비용을 더 내는 대신 얼굴이 안 보이는 구간을 사는 교환**이고, 그 대가로 새로 떠안는 주된 위험이 앞서 본 **(f) ID Switch**입니다. 프레임 단위 시스템의 오류는 한 프레임에서 끝나지만, 궤적 단위 시스템의 오류는 궤적 전체로 번지기 때문입니다.

## ID Switch를 어떻게 줄이는가

ID Switch를 줄이는 일은 결국 **매칭을 결정할 때 어디까지 깊은 단서를 보느냐**의 문제입니다. 가장 얕은 층은 "이 객체가 다음 프레임에 어디 있을지"라는 **위치** 단서이고, 위치만으로 후보가 갈리지 않을 때 한 층 더 들어가 "이 객체가 어떻게 생겼는지"라는 **외형** 단서를 봅니다. 최근 MOT tracker는 대부분 Detection 모델(e.g., YOLO) 위에 이 두 층을 쌓는 구조이므로, 얕은 층부터 차례로 보겠습니다.

### 1층. 위치 — Kalman Filter로 "어디로 움직일지"를 추정

Kalman Filter는 AI 모델이 아니라 베이지안 추론에 기반한 수학적 알고리즘입니다. 이전 프레임까지의 bounding box 위치와 속도를 바탕으로 "다음 프레임에서 이 객체가 어디에 있을지"를 추정합니다.

- **예측(Prediction)** — 현재 위치와 이동 속도·방향을 기반으로 다음 프레임의 위치를 선형(Linear)으로 계산합니다.
- **보정(Update)** — Detection 모델이 새로 찾아낸 bounding box(관측값)와 예측값을 비교해, 노이즈를 줄인 최종 위치로 갱신합니다.

한계는 **움직임이 선형이라는 가정**에 있습니다. 사람이 갑자기 방향을 틀거나 급격히 움직이면 예측이 어긋나고, 여기에 Detection 오차까지 함께 누적되면서 앞서 본 **(f) ID Switch**로 이어집니다.

### 2층. 외형 — Re-ID 모듈로 "누가 누구인지"를 검증

움직임만으로 부족한 부분을 외형 정보로 메우는 접근이 등장했고, 이를 대표적으로 정착시킨 것이 SORT에 외형 특징을 더한 **DeepSORT**입니다.

![tracking-by-detection 파이프라인 도식. 왼쪽의 video sequence가 object detection model로 들어가 bounding box를 내놓고, 이것이 한쪽으로는 motion-based similarity로, 다른 쪽으로는 ReID model을 거쳐 appearance features가 되어 appearance-based similarity로 들어간다. 두 유사도가 Kalman filter, hungarian algorithm, EMA와 연결되어 최종 tracks를 만든다. object detection model·motion-based similarity·Kalman filter·hungarian algorithm은 노란색 실선 블록이고, ReID model·appearance-based similarity·EMA는 빨간색 점선 블록이다](/images/smart-cctv-tracking/deep-sort-architecture.png)

*그림에서 노란색 실선 블록이 원래의 SORT이고, 빨간색 점선 블록이 DeepSORT가 추가한 부분입니다. 출처: Momir Adžemović, [Deep Learning-Based Multi-Object Tracking: A Comprehensive Survey from Foundations to State-of-the-Art (arXiv:2506.13457)](https://arxiv.org/abs/2506.13457), Fig. 5*

DeepSORT가 더한 것은 다음 세 가지입니다.

- **외형 특징 벡터(Feature Embedding) 추출** — Detector가 찾아낸 인물 영역 이미지에서 CNN으로 옷 색상, 체형, 스타일 등을 압축한 특징 벡터를 뽑습니다. 그림의 `ReID model` 블록입니다.
- **특징 누적을 통한 기억 유지** — track마다 지금까지의 외형 특징을 쌓아두고, 새로 검출된 객체와 코사인 유사도(Cosine Distance)를 비교합니다. 원 논문은 최근 $N$개 특징을 보관해 그중 최소 거리를 쓰는 방식이고, 이후 구현에서는 지수이동평균으로 하나의 벡터에 누적하는 방식이 널리 쓰입니다(그림의 `EMA` 블록).
- **모션과 외형의 결합** — Kalman Filter로 매칭 후보의 이동 범위를 먼저 제한(Gating)한 뒤, 공간적 거리(Mahalanobis Distance)와 외형 유사도를 함께 놓고 Hungarian algorithm으로 최종 매칭을 결정합니다.

역할은 이렇게 나뉩니다. **Kalman Filter가 "어디로 갈지(모션)"로 후보를 좁히고, Re-ID 모듈이 "누구인지(외형)"를 검증합니다.** 덕분에 인물이 격렬하게 움직이거나 잠시 다른 사람에게 가려졌다가(Occlusion) 다시 나타나 Kalman Filter의 위치 예측이 어긋나더라도, 외형 특징 벡터를 통해 원래 ID를 되찾을 수 있습니다.

> **참고 — Re-ID 모듈은 얼굴을 보지 않습니다.**
> 사람은 보통 얼굴로 타인을 구별하지만, DeepSORT와 같은 Re-ID 모듈이 보는 것은 얼굴이 아니라 **전신 외형(의상, 체형, 색상 패턴)** 입니다. 위에서 말한 "외형 특징 벡터"도 얼굴 Patch가 아니라 인물 bounding box 전체에서 뽑힙니다.
> Dietlmeier et al.은 Market1501, DukeMTMC-reID, CUHK03, VIPeR, Airport 등 주요 Re-ID 데이터셋에서 얼굴을 검출해 블러 처리한 뒤 여러 모델을 재평가했는데, mAP 하락이 매우 작았고 그마저도 블러된 데이터로 다시 학습하면 원래 성능을 회복했습니다. 즉 기존 Re-ID 모델의 성능은 얼굴 정보에 거의 의존하지 않습니다.
> 이는 데이터 조건상 자연스러운 결과이기도 합니다. MOT·Re-ID 공개 데이터셋은 원거리 CCTV 시점이 대부분이라 얼굴 영역의 해상도가 낮고 뒷모습·측면 프레임이 많아, 모델이 얼굴을 유의미한 단서로 학습하기 어려운 조건입니다.
> 바꿔 말하면 지금까지 본 Re-ID는 거칠게 말하면 **"같은 옷을 입은 같은 체형의 사람"을 이어붙이는 장치**이지, "누구인지"를 신원 수준에서 특정하는 장치가 아닙니다.

## 얼굴로 신원을 특정한다 — Face Matching Re-ID

앞의 두 층이 막는 것은 **한 궤적의 ID가 다른 사람에게 넘어가는 일**, 즉 ID Switch입니다. 그런데 위치와 외형만으로 ID를 지키는 구조에는 성격이 다른 실패가 하나 더 있습니다. 궤적이 서로 뒤섞이는 것이 아니라 **같은 사람에게 새 ID가 붙어 궤적이 쪼개지는 것**입니다. 그리고 어느 쪽이든 궤적에 붙어 있는 것은 여전히 임의의 번호일 뿐, "누구인지"는 아직 비어 있습니다.

외형 기반 Re-ID는 **외형이 유지되는 동안에만** 유효합니다. 다음 두 상황에서 같은 사람의 궤적이 쪼개집니다.

- **옷이 바뀐 뒤 재등장** — Re-ID 임베딩의 상당 부분은 결국 옷 색상과 패턴입니다. 인물이 겉옷을 벗거나 갈아입고 다시 들어오면 외형 유사도가 무너지고, tracker는 그를 처음 보는 사람으로 취급합니다. 하루 단위를 넘어가는 장기 재식별(Long-term Re-ID)에서 외형 특징이 쓸 수 없게 되는 것도 같은 이유입니다.
- **오래 사라졌다가 재등장** — tracker는 Track을 무한정 들고 있지 않습니다. 매칭되지 않은 프레임이 임계치(DeepSORT의 `max_age`)를 넘으면 연산량과 메모리를 아끼기 위해 해당 Track을 **의도적으로 삭제**하고, 그 뒤에 다시 나타난 인물은 새 Track으로 시작합니다. 즉 "잊어버리는 것"은 버그가 아니라 설계된 동작입니다.

Face Embedding 모델은 이 두 구멍을 정확히 메웁니다.

- **옷·체형 변화에 강함** — 얼굴 자체의 특징이 크게 변하지 않았다면, 옷을 갈아입어도 동일 인물로 판정됩니다.
- **잊지 않음** — 비교 대상이 tracker 내부의 휘발성 메모리가 아니라 **외부 Gallery(Face) DB에 저장된 임베딩**입니다. 인물이 얼마나 오래 화면에서 사라져 있었는지와 무관하게, 재등장한 궤적의 얼굴 임베딩을 Gallery DB와 대조해 원래 신원으로 되돌릴 수 있습니다.

Koide et al.이 RGB-D 카메라 네트워크에서 내린 결론도 같습니다. 외형 기반 방법은 결국 옷의 RGB 정보에 의존하므로 날짜를 넘기는 재식별에는 쓸 수 없고, 걸음걸이나 골격 길이 같은 soft biometric은 체형이 비슷한 사람들 사이에서 변별력을 잃는 반면, 얼굴은 개인을 구분하는 가장 변별력 있는 단서라는 것입니다.

다만 해당 논문이 동시에 지적하듯 **얼굴은 항상 보이지 않는다**는 것이 결정적인 제약입니다. 저화질, 측면·뒷모습, 조명 변화처럼 얼굴이 제대로 잡히지 않은 프레임의 임베딩은 신원 정보를 거의 담고 있지 않으면서 매칭 점수만 흔들어 놓기 때문에, Gallery DB 조회 전에 **그런 프레임을 걸러내는 품질 필터가 사실상 필수**가 됩니다. 앞서 본 "궤적 안에서 근거가 모이면 나머지 프레임까지 함께 확정된다"는 구조도, 어떤 프레임이 근거로 쓸 만한지 판정할 수 있을 때에만 성립합니다.

![Gallery DB와 프레임별 얼굴 유사도 비교 도식. 왼쪽에는 Luffy, Zoro, Sanji, Usopp 네 명의 gallery 얼굴 이미지가 세로로 놓여 있고, 오른쪽에는 같은 궤적 id-002에서 잘라낸 Luffy의 얼굴 crop 세 장이 나란히 있다. 왼쪽 crop은 32x32 픽셀로 형체만 남은 실루엣이고 네 명에 대한 유사도가 각각 9%, 8%, 7%, 6%로 모두 임계치 40% 아래라 미매칭 처리된다. 가운데 crop은 50x50 픽셀의 흐릿한 정면으로 Luffy 65%, Zoro 21%, Sanji 14%, Usopp 12%다. 오른쪽 crop은 60x60 픽셀의 선명한 정면으로 Luffy 81%, Zoro 17%, Sanji 11%, Usopp 9%다](/images/smart-cctv-tracking/face-similarity-by-quality.png)

> **예시: 동일 Track 내 Gallery-Probe 간 유사도의 변동성**
> 동일 Track(궤적) 내 3개 프레임에서 얼굴을 Crop하여 Gallery DB의 4명과 유사도를 대조한 예시입니다.
> 보행자가 카메라에 가까워짐에 따라 얼굴 Crop 크기는 $32\times32 \rightarrow 50\times50 \rightarrow 60\times60$ px로 커지고, 정답 인물(Luffy)과의 유사도 역시 9% $\rightarrow$ 65% $\rightarrow$ 81%로 크게 상승합니다.여기서 주목할 지점은 $t_1$ 프레임입니다. 정답 점수가 임계치($\tau$) 이하로 떨어질 뿐만 아니라, 후보 4명의 점수가 모두 비슷하게 낮아 순위 매기기 자체가 무의미한 상태가 됩니다.
> 이처럼 식별력을 상실한 프레임은 유의미한 신원 정보를 제공하지 못할 뿐만 아니라, Track 단위로 점수를 집계할 때 오히려 노이즈로 작용합니다. 따라서 Gallery DB를 조회하기 전, 품질 기반의 Pre-filtering을 통해 이러한 저품질 프레임을 선제적으로 걸러내는 과정이 필수적입니다.

## 어떤 얼굴을 Gallery DB에 물어볼 것인가

앞의 예시가 말하는 것은 **한 궤적 안의 얼굴들이 서로 같은 값어치를 갖지 않는다**는 사실입니다. 그러면 무엇을 남기고 무엇을 버릴지 정해야 하는데, 그 기준을 어디서 가져올 것인지가 문제입니다.

### 기준은 사람의 눈이 아니라 Face Embedder

가장 먼저 경계할 것은 **사람 눈에 좋아 보이는 얼굴을 고르는 것**입니다. 프레임을 거르는 목적은 보기 좋은 사진을 남기는 것이 아니라 **Face Embedder가 신원 정보를 뽑아낼 수 있는 입력을 남기는 것**이고, 두 기준은 생각만큼 일치하지 않습니다.

같은 이유로 "좋은 품질"은 절대적인 성질이 아니라 **모델에 상대적인 성질**입니다. 어떤 Embedder를 쓰는지, 어떤 데이터로 학습했는지에 따라 그 모델이 잘 읽어내는 얼굴의 조건이 달라집니다. 정면 위주로 학습한 모델과 다양한 각도를 본 모델은 같은 측면 얼굴에서 전혀 다른 임베딩 안정성을 보입니다.

물론 연구자들은 모델의 지각이 사람의 지각과 비슷하게 정렬되도록 설계합니다. 다만 **두 지각이 같은 축 위에 있지는 않다**는 것은 오래전부터 알려져 있습니다. Szegedy et al.은 사람 눈으로는 차이를 알아볼 수 없는 미세한 변형만으로 신경망의 판단이 완전히 뒤집히는 것을 보였습니다. 인위적으로 만들어낸 극단적 사례이므로 CCTV 프레임의 품질 기준을 여기서 곧바로 끌어낼 수는 없지만, **사람이 보는 이미지와 모델이 보는 이미지가 서로 다른 기준 위에 있다**는 근거로는 충분합니다. 그렇다면 품질의 기준도 사람의 감각에서 유추할 것이 아니라, 실제로 쓰는 Embedder를 놓고 측정해서 정해야 합니다.

### 선별 방법 — 학습 기반과 휴리스틱

Embedder가 좋아할 얼굴을 고르는 방법은 크게 두 갈래입니다.

- **학습 기반** — 궤적처럼 여러 장이 묶인 이미지들을 통째로 받아, 각 이미지에 매길 가중치를 학습으로 얻는 방식입니다. QAN은 품질 라벨 없이 인식 손실만으로 샘플별 품질 점수를 학습해 임베딩을 가중 합치고, NAN은 attention 모듈로 흐리거나 가려진 얼굴의 비중을 낮춰 이미지 집합 하나를 벡터 하나로 요약합니다. 입력 단위가 **이미지 집합(여러 이미지)** 이라 궤적 단위로 신원을 부여하는 구조와 잘 맞습니다.
- **휴리스틱** — 해상도, 각도, 블러처럼 계산 가능한 지표로 거르는 방식입니다. 구현이 싸고 해석이 되며, 임계값을 운영 중에 바로 조정할 수 있습니다.

처음 Smart CCTV를 만들 때는 보통 휴리스틱으로 baseline을 세우고, 개선 여지가 확인된 뒤에 학습 기반으로 넘어갑니다. 이 글도 휴리스틱을 기준으로 이야기하겠습니다.

### FIQA — 후보 도구들

얼굴 이미지의 품질을 측정하는 문제는 **FIQA(Face Image Quality Assessment)** 라는 이름으로 정리되어 있습니다. 실무에서 후보로 세울 만한 지표들을 출처별로 묶으면 다음과 같습니다.

| 출처 | 후보 예시 |
| --- | --- |
| **임베딩 모델** | SER-FIQ, 임베딩 벡터의 크기(norm) |
| **Detector·Landmark** | Detector 신뢰도, 정면도, yaw 절댓값, 두 눈 사이 거리, 코 위치 오프셋 |
| **픽셀** | 정렬된 crop의 Laplacian 분산(블러) |
| **박스 크기** | 얼굴 최소변 px |

여기서 구분해야 할 것이 있습니다. FIQA는 **"일반적으로 좋은 얼굴 이미지란 무엇인가"** 에 답하는 도구 모음입니다. 반면 Smart CCTV에서 풀어야 하는 문제는 **그 도구들 중 내가 쓰는 Embedder와 정렬(align)된 것이 무엇인지 고르는 것**입니다. 전자는 문헌이 답해주지만, 후자는 내 현장 데이터에서 직접 측정해봐야 합니다.

> **참고 — 유사도 분포 자체를 품질 신호로 쓰면 안 될까**
>
> 모든 얼굴을 일단 Embedder에 태워 Gallery와 대조한 뒤, 후보 점수가 고르게 퍼져 있거나 rank-1 유사도가 임계치에 못 미치는 얼굴을 버리는 방법도 생각할 수 있습니다. 앞의 첫 그림에서 $t_1$이 정확히 그런 상태였습니다. 네 명의 점수가 모두 비슷하게 낮아 순위가 무의미했으니, 그 자체가 쓸 만한 신호로 보입니다. 그런데 왜 FIQA와 같은 품질 측정 도구를 쓸까요?
>
> 먼저, 비용이 먼저 걸립니다. 위 표의 지표들은 Embedder를 태우기 **전에** 계산되지만, 이 방식은 모든 얼굴에 대해 임베딩 추출과 1:N 조회를 끝낸 **뒤에야** 점수가 나옵니다. 파이프라인은 싼 게이트를 앞에, 비싼 판정을 뒤에 두는 편이 자연스럽습니다.
>
> 다만 더 중요한 것은 **측정하는 대상이 다르다**는 점입니다. FIQA는 Gallery와 무관하게 "이 얼굴에 신원 정보가 실려 있는가"를 묻지만, 유사도 분포는 "이 얼굴이 내 Gallery의 누군가와 닮았는가"를 묻습니다. 그래서 이 신호로는 **저품질 얼굴과 미등록 인물을 구분할 수 없습니다.** 완벽하게 찍힌 미등록 인물의 얼굴도 분포는 평평하게 나오는데, 이것은 버릴 이미지가 아니라 `unknown`으로 보고해야 할 이미지입니다. rank-1 임계치로 거르는 것 역시 뒤에서 다룰 **미등록 인물 판정을 프레임 단위로 앞당긴 것**이라, 미등록 인물의 궤적은 모든 프레임이 탈락해 합칠 것이 남지 않습니다.
>
> 그래서 이 신호는 게이트가 아니라 **결합 단계의 가중치**로 쓰는 편이 맞습니다. 1위와 2위의 margin이나 분포의 엔트로피를 프레임별 신뢰도로 두고 가중합하는 방식이고, 앞서 언급한 QAN·NAN이 그 가중치를 학습으로 얻는 접근입니다. 검증할 때는 한 가지 더 조심해야 합니다. 이 점수는 정오를 판정하는 데 쓴 유사도에서 나오므로, 그대로 AUROC를 재면 낙관 쪽으로 편향됩니다.

### 정렬된 도구는 감이 아니라 측정으로 고른다

얼굴 bbox와 인물 ID를 라벨링한 GT 위에서, 순서는 세 단계입니다.

1. **개선 여지부터 확인합니다.** 정답을 보고 반칙으로 가장 잘 골랐을 때 오류율이 어디까지 내려가는지(오라클 ERC 곡선)를 먼저 측정합니다. 이 하한선이 현재 오류율과 거의 붙어 있으면 **품질 게이트를 만들지 않는 것이 옳은 결정**입니다. 가장 잘 골라도 얻을 것이 없다는 뜻이고, 병목은 해상도·카메라 화각·Gallery 등록 방식 쪽에 있습니다.
2. **후보의 예측력을 검증합니다.** 각 지표가 매칭 성패를 실제로 예측하는지 AUROC로 측정하되, 점추정치가 아니라 **인물 단위 부트스트랩 신뢰구간의 하한이 0.5를 넘는지**로 판정합니다. 소수 인물이 신호를 통째로 끌고 있는 경우를 걸러내기 위해서입니다.
3. **임계값은 AUROC가 아니라 ERC에서 정합니다.** AUROC는 순서를 얼마나 잘 매기는지만 답합니다. 운영에서 답해야 하는 질문은 "하위 몇 %를 버리면 오류율이 얼마가 되는가"이고, 그것은 ERC 곡선에서 읽습니다.

이 과정에서 상식이 자주 깨집니다. "화질이 나쁘면 못 알아본다"는 직관과 달리 블러 지표나 박스 크기가 단독 기준으로는 신뢰구간을 통과하지 못하는 경우가 흔합니다. 각 단계의 구체적인 설계와 함정은 <a href="#" data-series-post="2026-09-10-smart-cctv-probe-evaluation.md">Smart CCTV, 문제는 알고리즘일까 영상 품질일까</a> 글의 5\~6절에 정리해 두었습니다.


## Track에 어떤 person_id를 붙일 것인가

프레임 선별까지 마치고 나면 마지막 문제 하나가 남습니다. **남은 얼굴들의 판단을 어떻게 하나의 결론으로 합칠 것인가.**

직관적으로 잘 와닿지 않을 수 있지만, 이는 여러 개의 판단을 모아 가장 정답 확률이 높은 분류값을 내놓는 **앙상블(ensemble)** 문제로 구조화됩니다. 정리하면 이렇습니다.

- 궤적 $T$에서 선별을 통과한 프레임 $f_1, \dots, f_N$
- Gallery 후보 $c \in C = \{\text{Luffy}, \text{Zoro}, \text{Sanji}, \text{Usopp}\}$
- 프레임 $f_i$의 임베딩과 후보 $c$의 Gallery 임베딩 사이 유사도 $s_i(c)$

$$\hat{c} = \arg\max_{c \in C} \; F\big(s_1(c), \dots, s_N(c)\big)$$

즉 $N \times |C|$ 짜리 유사도 표 하나를 놓고 후보 하나를 고르는 문제이고, 여기서 정해야 하는 것은 **결합 함수 $F$** 입니다. [On Combining Classifiers](https://ieeexplore.ieee.org/document/667881)는 이 $F$의 후보들을 베이즈 결정 규칙에서 유도해 정리한 고전입니다.

![결합 규칙 비교 도식. 위쪽에는 Track id-002의 선별된 5개 프레임 f1부터 f5와 Gallery 4명(Luffy, Zoro, Sanji, Usopp)의 유사도를 담은 4행 5열 히트맵 표가 있다. Luffy는 62, 71, 1, 66, 58이고 Zoro는 24, 19, 88, 22, 26, Sanji는 18, 22, 31, 25, 21, Usopp은 15, 17, 24, 19, 23이다. 얼굴이 일부 가려진 f3 열이 빨간 테두리로 강조되어 있는데, 이 프레임에서만 Zoro가 88%로 튀고 Luffy는 1%로 떨어진다. 아래쪽 표는 결합 규칙별 집계 결과다. Sum은 Luffy 258로 정답, Median은 Luffy 62로 정답, Majority vote는 Luffy 4표로 정답인 반면, Max는 Zoro 88로 오답, Min은 Zoro 19로 오답, Product는 Zoro가 2.3x10^-3으로 오답이다](/images/smart-cctv-tracking/combining-rules.png)

*궤적 하나에 대한 유사도 표와, 같은 표에 서로 다른 결합 규칙을 적용했을 때의 판정. f3 한 장 때문에 규칙마다 다른 인물이 선택됩니다 (수치는 설명을 위한 예시 값입니다)*

### 규칙별로 무엇이 달라지는가

위 표를 기준으로 각 규칙이 무엇을 보는지 정리하면 이렇습니다.

- **Sum rule (합·평균)** — 후보별로 프레임 점수를 모두 더합니다. 한 장이 튀어도 나머지 $N-1$장이 눌러줍니다. 예시에서 f3이 Luffy를 1%까지 떨어뜨렸지만, 남은 네 장 덕분에 258로 1위를 지킵니다.
- **Product rule (곱)** — 후보별로 점수를 곱합니다. 프레임들이 서로 독립이라는 가정 아래 베이즈 규칙에서 곧바로 유도되는 가장 "정통"인 형태지만, **한 장이라도 0에 가까우면 그 후보는 사실상 거부권(veto)에 걸립니다.** 예시의 Luffy는 f3의 1% 하나 때문에 $1.7 \times 10^{-3}$으로 내려앉아 Zoro에게 집니다.
- **Max rule** — 후보별 최고 점수 하나로 결정합니다. 궤적에서 **가장 잘 찍힌 한 장만 믿는 방식**이고, 실무에서 "best frame 한 장만 조회한다"로 흔히 쓰입니다. 문제는 그 한 장이 우연히 높게 나온 오답일 때 그대로 끌려간다는 것입니다. 예시의 f3에서 Zoro가 88%를 받은 경우가 정확히 그렇습니다.
- **Min rule** — 후보별 최저 점수를 구한 뒤, 그중 가장 높은 후보를 고릅니다. "어떤 프레임에서도 이만큼은 나온다"는 보수적인 기준이지만, 가려진 프레임 한 장이 정답 후보를 탈락시킵니다. 예시에서 Luffy의 최저 점수는 f3의 1%라 곧바로 탈락하고, 최저 19%를 지킨 Zoro가 뽑힙니다.
- **Median rule** — 후보별 중앙값으로 결정합니다. Sum과 비슷하게 움직이면서 **극단값 한두 장을 구조적으로 무시**합니다. 프레임 수가 적어(3\~5장) 평균이 한 장에 흔들릴 수 있는 상황에서 유용합니다.
- **Majority vote rule** — 프레임마다 1위 후보에게 한 표씩 주고 최다 득표자를 고릅니다. 점수의 크기를 버리고 순위만 쓰기 때문에 프레임마다 점수 스케일이 들쭉날쭉해도 견딥니다. 대신 **65%로 이긴 한 표와 1%p 차로 이긴 한 표를 똑같이 셉니다.**

### 어떤 규칙을 기본값으로 둘 것인가

Kittler et al.의 결론은 다소 역설적입니다. 이론적으로 가장 정통인 것은 product rule이지만, **실험에서 가장 견고했던 것은 sum rule**이었습니다. 이유는 오차에 대한 민감도입니다. 각 추정치에 섞인 오차를 sum은 평균으로 희석하는 반면, product는 곱셈으로 증폭시켜 하나의 나쁜 추정치가 결과 전체를 지배합니다.

이 성질은 Smart CCTV에 그대로 옮겨옵니다. 프레임 한 장의 임베딩이 나쁘게 잡히는 일은 흔하고, 품질 게이트로도 전부 막지 못합니다. **한 장의 사고가 궤적 전체의 신원을 뒤집어서는 안 된다**는 요구가 곧 sum이나 median을 기본값으로 두라는 뜻이 됩니다. 반대로 max·min·product는 설계상 한 장에 판정을 맡기는 규칙이므로, 쓸 이유가 분명할 때만 선택해야 합니다.

다만 원 논문의 설정을 그대로 가져올 때 주의할 점이 두 가지 있습니다.

- **결합 대상이 다릅니다.** 원 논문은 서로 다른 표현을 쓰는 **여러 분류기**를 결합하지만, 여기서는 하나의 Embedder가 **여러 관측(프레임)** 을 본 결과를 결합합니다. 수식의 형태는 같아도 독립 가정은 훨씬 약합니다. 인접한 두 프레임은 픽셀이 거의 같아 사실상 같은 표를 두 번 던지는 셈이라, 프레임을 시간적으로 벌려 뽑거나 유사한 프레임의 가중치를 낮추는 전처리가 필요합니다.
- **유사도는 확률이 아닙니다.** Sum·product rule은 후보 전체에 대한 확률로 다뤄야 의미가 맞습니다. 프레임마다 $\sum_{c} p_i(c) = 1$이 되도록 정규화한 뒤 적용하는 것이 정석이고, 위 예시는 설명을 위해 유사도 값을 그대로 두었습니다.

어떤 규칙이 맞는지는 결국 앞 절과 같은 방식으로 **측정해서 고를 문제**입니다. 궤적 단위 정답 라벨을 놓고 규칙별 오류율을 나란히 비교하면, 이 글의 예시처럼 규칙 하나 바꾸는 것만으로 성적이 갈리는 구간이 드러납니다.

### 등록되지 않은 사람은 어떻게 처리하는가

여기까지의 결합 규칙에는 조용한 가정이 하나 깔려 있습니다. $\hat{c} = \arg\max_{c \in C} F(\cdot)$는 **후보 집합 $C$ 안에 정답이 반드시 있다**고 보고 그중 1등을 고릅니다. 하지만 실제 CCTV에 잡히는 사람 대부분은 Gallery에 등록되어 있지 않습니다. 등록 인원이 네 명이라면 그 네 명이 아닌 모든 사람이 그중 하나로 강제 배정됩니다. 그래서 결합 뒤에 **"아무도 아니다"라고 말할 수 있는 출구**를 따로 만들어야 합니다.

- **집계 점수의 절대 임계치** — 1위 후보의 결합 점수가 임계치 $\theta$에 못 미치면 `unknown`으로 둡니다. 주의할 점은 **결합 규칙마다 값의 스케일이 완전히 다르다**는 것입니다. sum은 프레임 수 $N$에 비례해 커지고, median은 유사도와 같은 범위에 머물며, product는 $N$이 늘수록 0에 가까워집니다. 규칙을 바꾸거나 프레임 수 정책을 바꾸면 $\theta$는 매번 다시 잡아야 합니다. sum을 쓴다면 $N$으로 나눈 평균을 임계치의 기준으로 두는 편이 안전합니다.
- **1위와 2위의 margin** — 1등 점수가 높아도 2등과 거의 붙어 있으면 그 판정은 믿을 것이 못 됩니다. 절대 점수와 margin을 함께 걸어, 둘 중 하나라도 미달이면 `unknown`으로 보내는 구성이 실무에서 무난합니다.

앞의 참고 박스에서 짚었듯 **저품질 프레임과 미등록 인물은 유사도 분포만 보면 똑같이 생겼습니다.** 둘 다 후보 점수가 고르게 낮습니다. 그래서 순서가 중요합니다. **품질 게이트를 먼저 통과시킨 프레임들만 결합한 다음, 그 결과에 `unknown` 판정을 겁니다.** 이 순서를 지키면 "볼 수 있었는데 아무와도 닮지 않았다"와 "애초에 볼 것이 없었다"가 분리되고, 후자는 미등록 인물이 아니라 **판정 불가(`uncertain`)** 로 따로 보고할 수 있습니다. 한 궤적에서 품질 게이트를 통과한 프레임이 0장이면 그 궤적은 `unknown`이 아니라 판정 불가(`uncertain`)입니다.

임계치 자체는 감으로 정할 수 없습니다. 검증셋에 **Gallery에 등록되지 않은 인물의 궤적을 반드시 섞은 뒤**, 미등록 인물을 등록 인물로 오인하는 비율(FAR)과 등록 인물을 `unknown`으로 놓치는 비율(FRR)이 운영 요구에 맞는 지점을 골라야 합니다. 어느 쪽 오류가 더 비싼지는 시스템의 용도에 따라 갈립니다. 출입 통제라면 FAR을 극단적으로 낮춰야 하고, 사후 검색이라면 FRR을 낮게 두고 사람이 확인하는 편이 낫습니다.

덧붙이면, `unknown` 판정은 **프레임 단위보다 궤적 단위에서 훨씬 안정적입니다.** 프레임 단위로 임계치를 걸면 같은 사람이 1초 안에 등록 인물과 `unknown`을 오가지만, 궤적 단위로는 판정이 한 번만 일어나기 때문입니다. 이는 앞의 비교표에서 "프레임 단위로 흔들림 vs 궤적 단위로 오염"이라고 적었던 차이가 미등록 인물 쪽에도 그대로 적용되는 경우입니다.


---

**출처 및 참고**
- Momir Adžemović, [Deep Learning-Based Multi-Object Tracking: A Comprehensive Survey from Foundations to State-of-the-Art (arXiv:2506.13457)](https://arxiv.org/abs/2506.13457), 2025 — 「MOT 정의」의 수식 (1)\~(3)은 §3.1 Problem Formulation을, 「MOT는 어떤 식으로 틀리는가」의 그림과 (a)\~(f) 분류는 Fig. 2를, DeepSORT 파이프라인 그림은 Fig. 5를 따랐습니다
- Nicolai Wojke, Alex Bewley, Dietrich Paulus, [Simple Online and Realtime Tracking with a Deep Association Metric (arXiv:1703.07402)](https://arxiv.org/abs/1703.07402), 2017 — DeepSORT 원 논문
- Julia Dietlmeier, Joseph Antony, Kevin McGuinness, Noel E. O'Connor, [How important are faces for person re-identification? (arXiv:2010.06307)](https://arxiv.org/abs/2010.06307), ICPR 2020 — 「Re-ID 모듈은 얼굴을 보지 않습니다」 참고 박스의 근거. Market1501·DukeMTMC-reID·CUHK03·VIPeR·Airport의 얼굴을 블러 처리해도 mAP 하락이 미미했고, 블러 데이터로 재학습하면 성능이 회복된다는 실험 결과
- Kenji Koide, Emanuele Menegatti, Marco Carraro, Matteo Munaro, Jun Miura, [People Tracking and Re-Identification by Face Recognition for RGB-D Camera Networks](https://staff.aist.go.jp/k.koide/assets/pdf/ecmr2017.pdf), ECMR 2017 — 「Face Matching Re-ID」의 근거. 외형 기반 재식별은 옷의 RGB 정보에 의존해 날짜를 넘기면 쓸 수 없고, soft biometric(걸음걸이·골격)은 체형이 비슷하면 변별력을 잃으며, 얼굴이 가장 변별력 있는 단서이지만 항상 보이지는 않는다는 §I의 논의
- Harshit S, Cyril Victor, Pravin M, Ashwin Kumar, [Person Re-Identification System Using Facial Recognition: A Literature Survey](https://doi.org/10.22214/ijraset.2025.69315), IJRASET 13(IV), 2025 — 얼굴 기반 Re-ID가 해상도·조명에 민감하고 자세 변화·occlusion에서 성능이 떨어진다는 Table 1의 정리
- Christian Szegedy, Wojciech Zaremba, Ilya Sutskever, Joan Bruna, Dumitru Erhan, Ian Goodfellow, Rob Fergus, [Intriguing properties of neural networks (arXiv:1312.6199)](https://arxiv.org/abs/1312.6199), ICLR 2014 — 사람 눈에 보이지 않는 미세한 변형으로 신경망의 판단이 뒤집힌다는, 모델의 지각과 사람의 지각이 별개의 축이라는 근거
- Yu Liu, Junjie Yan, Wanli Ouyang, [Quality Aware Network for Set to Set Recognition (arXiv:1704.03373)](https://arxiv.org/abs/1704.03373), CVPR 2017 — 품질 라벨 없이 인식 손실만으로 집합 내 샘플별 품질 가중치를 학습
- Jiaolong Yang, Peiran Ren, Dongqing Zhang, Dong Chen, Fang Wen, Hongdong Li, Gang Hua, [Neural Aggregation Network for Video Face Recognition (arXiv:1603.05474)](https://arxiv.org/abs/1603.05474), CVPR 2017 — attention으로 흐리거나 가려진 얼굴의 비중을 낮춰 집합을 벡터 하나로 요약
- Torsten Schlett, Christian Rathgeb, Olaf Henniger, Javier Galbally, Julian Fierrez, Christoph Busch, [Face Image Quality Assessment: A Literature Survey (arXiv:2009.01103)](https://arxiv.org/abs/2009.01103), ACM Computing Surveys 2022 — FIQA 개괄 및 ERC/EDC 곡선의 정의
- Josef Kittler, Mohamad Hatef, Robert P. W. Duin, Jiri Matas, [On Combining Classifiers](https://ieeexplore.ieee.org/document/667881), IEEE TPAMI 20(3), 1998 — 「Track에 어떤 person_id를 붙일 것인가」의 결합 규칙(sum·product·max·min·median·majority vote)과, product 대비 sum rule이 추정 오차에 더 견고하다는 민감도 분석
- 같은 시리즈: <a href="#" data-series-post="2026-09-10-smart-cctv-probe-evaluation.md">Smart CCTV, 문제는 알고리즘일까 영상 품질일까</a> — 「정렬된 도구는 감이 아니라 측정으로 고른다」의 세 단계(오라클 ERC 상한, 인물 단위 부트스트랩 AUROC, ERC 기반 임계값 결정)를 5\~6절에서 자세히 다룹니다
