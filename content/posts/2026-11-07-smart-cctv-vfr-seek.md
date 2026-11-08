---
title: "Smart CCTV, Video decoding 주의사항(CFR vs VFR)"
date: 2026-11-07
category: ai
summary: CCTV 녹화본처럼 프레임 간격이 일정하지 않은 VFR 영상에서 OpenCV의 seek(CAP_PROP_POS_MSEC / POS_FRAMES)방식이 경고 없이 엉뚱한 프레임을 돌려주는 이유. CFR과 VFR, PTS와 컨테이너 인덱스, Keyframe과 GOP를 정리하고, VFR 판별법과 순차 디코딩·PyAV seek·CFR 변환 같은 대처법, 그리고 VFR이 AI 모델(MOT의 Kalman Filter)에 끼치는 영향까지 다룹니다.
tags: ["Smart CCTV", "Video Decoding", "OpenCV", "FFmpeg", "VFR", "Computer Vision"]
series: Smart CCTV
series_order: 3
---

> **TL;DR**
>
> CCTV 영상의 5초~7초 구간을 추출해 AI 모델에 넣으려고 OpenCV의 `set` 함수를 호출하면, 영상이 **VFR(가변 프레임 레이트)** 일 때 OpenCV는 다른 시간 지점의 프레임을 경고 없이 돌려줍니다.
>
> 원인은 OpenCV가 내부적으로 위치를 **프레임 번호**로 다루고, 시간과 프레임 번호를 오갈 때 고정된 FPS를 가정하고 처리하기 때문입니다. CFR이면 이 환산이 정확하지만 VFR에서는 성립하지 않습니다.
>
> 대처는 세 가지입니다. 
> **① PyAV처럼 PTS 기준으로 seek한 뒤 PTS로 도착을 판단**하거나
> **② (seek를 믿을 수 없을 때) 프레임마다 실제 시각(PTS)을 읽으면서 처음부터 순차 디코딩**하거나
> **③ 분석 전에 CFR로 변환**합니다.

이 글은 Smart CCTV 시리즈의 세 번째 글입니다. <a href="#" data-series-post="2026-09-12-smart-cctv-tracking.md">앞 글</a>에서는 전신 추적(MOT)으로 궤적을 먼저 잇고 그 위에 신원을 붙이는 구조를 다뤘습니다. 이번에는 그보다 한 단계 앞, **영상에서 프레임을 꺼내는 단계**에서 조용히 생기는 문제를 다룹니다.

## 문제 제기

영상의 특정 구간(예: 5초~7초)을 추출해 AI 모델로 정밀 분석한다고 가정해 보겠습니다. 
이를 위해서는 먼저 그 구간의 프레임을 꺼내야 합니다.
Python에서는 OpenCV로 원하는 시점이나 프레임 번호로 바로 이동(seek)하는 방식이 있기 때문에 이를 통해 구현해보도록 하겠습니다.

```python
import cv2

cap = cv2.VideoCapture('video.mp4')

# 100번째 프레임으로 이동
cap.set(cv2.CAP_PROP_POS_FRAMES, 100)
ret, frame = cap.read()

# 5000ms (5초) 위치로 이동
cap.set(cv2.CAP_PROP_POS_MSEC, 5000)
ret, frame = cap.read()
```

위의 방식은 영상이 CFR(Constant Frame Rate)이면 문제가 없습니다. 
하지만 VFR(Variable Frame Rate) 영상, 대표적으로 **CCTV 녹화본**이라면 5초 위치를 요청했는데 7초가 넘은 지점의 프레임이 돌아올 수 있습니다.

더 곤란한 점은 OpenCV가 **아무 경고 없이** 동작한다는 것입니다. 

왜 이런 일이 생기는지 이해하려면 CFR/VFR, 그리고 비디오 파일이 프레임과 시간을 저장하는 방식을 알아야 합니다.

## 1. CFR과 VFR

### CFR (Constant Frame Rate, 고정 프레임 레이트)

비디오는 정지 이미지(프레임)를 시간 순서대로 이어 붙인 데이터이고, CFR은 그 간격이 일정한 형식입니다.

- 30fps라면 1초에 30장, 즉 약 $33.33\text{ms}(= \frac{1}{30}\text{초})$마다 한 장씩 기록하고, 재생할 때도 $33.33\text{ms}$마다 한 장씩 넘깁니다.
- 그래서 프레임 번호와 시각이 곱셈 하나로 정확히 환산됩니다.

$$\text{100번째 프레임의 시각} = \frac{100}{30\text{fps}} \approx 3.333\text{초}$$

- 반대로 "3.333초의 프레임"을 요청하면 정확히 100번째 프레임을 가져오면 됩니다.

### VFR (Variable Frame Rate, 가변 프레임 레이트)

VFR은 프레임 사이 간격이 일정하지 않습니다. 
어떤 구간은 촘촘하게, 어떤 구간은 듬성듬성 기록됩니다. 
그러면 **프레임 번호와 시각 사이의 관계식이 사라집니다.**

이 글에서는 다음 예시 하나로 설명하겠습니다.

> **예시:**
처음 5초(0~5초)는 아무도 지나가지 않아 카메라가 **15fps**로 낮춰 기록
이후 5초(5~10초)부터 사람이 걸어 들어와 다시 **30fps**로 기록

| 구간 | 기록 속도 | 프레임 수 | 프레임 번호 |
| --- | --- | --- | --- |
| 0 ~ 5초 (조용함) | 15fps | 75장 | 0 ~ 74번 |
| 5 ~ 10초 (사람 등장) | 30fps | 150장 | 75 ~ 224번 |

CFR이었다면 5초 지점은 $5 \times 30 = 150$번 프레임입니다. 하지만 이 영상에서 5초 지점은 **75번** 프레임입니다.

#### VFR 영상으로 저장 or 처리하는 이유

VFR은 의도적으로 쓰이기도 하고, 녹화 과정에서 결과적으로 생기기도 합니다. CCTV에서는 둘 다 흔합니다.

- **움직임 적응형 녹화** — 일부 카메라/NVR은 화면 변화가 거의 없는 구간(새벽 시간대 등)에서 초당 프레임 수를 낮추고, 움직임이 감지되면 다시 올려 저장 공간을 아낍니다. 위 예시가 이 경우입니다.
- **저조도 노출** — 어두운 환경에서 노출 시간을 늘리면 1초에 찍을 수 있는 프레임 수 자체가 줄어듭니다.
- **프레임 드롭과 네트워크 지연** — 카메라·인코더 부하나 RTSP 스트림의 패킷 손실로 프레임이 빠지고, 녹화기가 프레임이 **도착한 시각**을 타임스탬프로 찍으면 간격이 들쭉날쭉해집니다.

## 2. 비디오 파일 저장 방법

CFR이든 VFR이든 컨테이너(MP4, MKV, TS 등)는 각 프레임에 **PTS(Presentation Timestamp, 이 프레임을 화면에 띄울 시각)** 를 붙여 저장합니다.

| **구분** | **CFR (30fps)** | **예시 영상 (VFR)** |
| --- | --- | --- |
| **0번째 프레임** | $0\text{ms}$ | $0\text{ms}$ |
| **1번째 프레임** | $33\text{ms}$ | $67\text{ms}$ |
| **2번째 프레임** | $67\text{ms}$ | $133\text{ms}$ |
| **i번째 프레임** | 약 $33 \times i \text{ms}$ | ... |
| **75번째 프레임** | $2{,}500\text{ms}$ | $5{,}000\text{ms}$ |
| **150번째 프레임** | $5{,}000\text{ms}$ | $7{,}500\text{ms}$ |

여기서 프레임 번호를 기준으로 비디오를 저장하면 바로 원하는 프레임을 찾을 수 있어보입니다.
그런데 기준이 프레임 번호가 아니라 **시각**인 이유는 영상 파일에 비디오만 들어 있는 것이 아니기 때문입니다. 
대부분의 영상에는 오디오도 함께 들어 있고, 둘은 성격이 다릅니다.

- **비디오는 이산적**입니다. 이미지가 띄엄띄엄 한 장씩 있고, 다음 이미지가 나올 때까지 이전 이미지가 화면에 그대로 머뭅니다.
- **오디오는 사실상 연속적**입니다. 소리는 초당 48,000번처럼 매우 촘촘하게 샘플링되기 때문에, 어느 시각을 집어도 그 순간의 소리가 있습니다.

둘을 함께 재생하려면 "이 이미지가 보일 때 어떤 소리가 나와야 하는가"를 맞춰야(싱크) 합니다. 
이때 비디오의 프레임 번호는 기준이 될 수 없습니다. 
"1번 프레임"이라는 말에는 오디오의 어디에 해당하는지에 대한 정보가 없고, VFR이라면 프레임 간격이 제각각이라 번호만으로는 계산할 수도 없습니다. 
반면 **시각**은 비디오와 오디오가 모두 이해하는 공통 단위입니다.

예를 들어 예시 영상을 재생하다가 100ms 지점에 왔다면,

- **오디오:** 연속적인 흐름이므로 100ms 지점의 소리($48{,}000 \times 0.1 = 4{,}800$번째 샘플)를 바로 찾을 수 있습니다.
- **비디오:** 100ms에 정확히 찍힌 이미지는 없습니다. 대신 67ms에 찍힌 1번 프레임이 133ms에 2번 프레임이 나올 때까지 화면에 머물러 있으므로, 1번 프레임을 보여줍니다. (PTS가 100ms 이하인 마지막 프레임)

그래서 컨테이너는 프레임마다 "몇 번째인지"가 아니라 **"몇 초에 보여줄지"(PTS)** 를 기록합니다.

그렇다면 "N번째 프레임"을 찾을 수 있는 정보는 어디에 있을까요? **컨테이너마다 다릅니다.**

| 컨테이너 | 프레임 단위 인덱스 | 결과 |
| --- | --- | --- |
| **MP4 / MOV** | 있음. 모든 프레임의 시각과 키프레임 목록을 담은 **샘플 테이블**이 있음 | 몇 번째 프레임이 몇 초인지 정확히 알 수 있음 |
| **MKV / WebM** | 부분적. 보통 **키프레임 위치만** 기록됨 | 프레임 번호는 추정해야 함 |
| **MPEG-TS** (RTSP 녹화, 방송 등) | 없음. 프레임마다 PTS만 있고 파일 전체 인덱스가 없음 | seek 자체가 추정에 의존 |

CCTV 녹화본은 NVR 제조사에 따라 MP4, TS, 혹은 자체 포맷을 MP4로 변환한 파일 등 다양한 형태로 들어옵니다.
**같은 코드가 어떤 현장에서는 맞고 어떤 현장에서는 틀리는** 상황이 생기기 쉬운 이유입니다.

## 3. Keyframe(I-frame)과 B/P-frame

비디오는 용량을 줄이기 위해 대부분의 프레임을 다른 프레임과의 **차이**로 저장합니다.

- **I-frame (Keyframe):** 다른 프레임을 참조하지 않고 **혼자서 복원 가능한** 프레임입니다. 압축이 안 된 원본은 아니고, JPEG처럼 그 프레임 안에서만 압축한 것입니다.
- **P-frame:** **앞쪽** 프레임과의 차이만 저장합니다.
- **B-frame:** **앞뒤** 프레임과의 차이만 저장합니다.

키프레임 하나에서 다음 키프레임 직전까지를 GOP(Group of Pictures)라고 부르고, 예를 들면 다음과 같이 묶입니다.

$$\text{[ I ]} \rightarrow \text{[ B ]} \rightarrow \text{[ B ]} \rightarrow \text{[ P ]} \rightarrow \text{[ B ]} \rightarrow \text{[ B ]} \rightarrow \text{[ P ]} \rightarrow \text{[ I ]}$$

1번째 프레임(B)을 복원하려면 0번째 I-frame과 **뒤에 있는** 3번째 P-frame이 모두 필요합니다. 
즉 **임의의 프레임은 혼자 복원할 수 없습니다.**

그래서 원하는 프레임을 얻으려면 그보다 앞에 있는 가장 가까운 키프레임으로 점프한 뒤, 거기서부터 목표 프레임까지 순서대로 디코딩해야 합니다. 
seek는 "점프" 한 번이 아니라 **"점프 + 순차 디코딩"** 입니다.

## 4. OpenCV의 seek 작동 원리

OpenCV에서 원하는 시점으로 이동할 때 내부에서 일어나는 일을 간단한 코드로 표현하면 다음과 같습니다. 
(주의: 실제 OpenCV 코드가 아니라 원리를 보여주기 위한 의사코드입니다.)

```python
fps = 30                         
# 키프레임 위치(ms). 예시 영상은 0초에만 키프레임이 있다고 가정
keyframe_pts = [0, 10000]        

def set_pos_msec(ms):
    # 5000ms → 150번 프레임
    target = round(ms / 1000 * fps)
    return seek(target)

def seek(target):                
    # 예시: 150번 → 5000ms (다시 시각으로)
    target_ms = target / fps * 1000          

    # ① 목표 시각 이전의 가장 가까운 키프레임으로 점프 
    # (내부적으로 FFmpeg av_seek_frame 이용)
    start_pts = max(pts for pts in keyframe_pts if pts <= target_ms)

    # ② 착지한 키프레임이 "몇 번 프레임인지"를 시각으로 추정 (CFR 가정)
    current = round(start_pts / 1000 * fps)  # 0ms → 0번
    print(f"{start_pts}ms 키프레임으로 점프 ({current}번이라고 가정)")

    # ③ 목표 번호가 될 때까지 한 장씩 디코딩하며 셈
    while current < target:
        decode_next_frame()
        current += 1
    print(f"{target}번 프레임 도착")
```

키프레임은 **시각**으로 찾지만, 거기서부터 목표까지는 **장 수**를 셉니다. 
시각과 장 수를 오갈 때는 `fps`를 곱하고 나누기만 합니다. 
같은 코드를 CFR 영상과 예시 영상(VFR)에 넣어 보면 차이가 드러납니다.

| `set_pos_msec(5000)` | CFR (30fps) | 예시 영상 (VFR) |
| --- | --- | --- |
| ① 5000ms → 150번으로 환산 | 150번 | 150번 |
| ② 0ms 키프레임으로 점프 | 0번 | 0번 |
| ③ 150장을 세어 도착한 프레임 | 150번 = **5.0초** ✅ | 150번 = **7.5초** ❌ |

CFR에서는 150장째가 정확히 5초입니다. 
하지만 예시 영상은 앞 5초 동안 75장뿐이라, 150장을 세면 5초를 지나 **7.5초**에 도착합니다. ($5 + \frac{150 - 75}{30} = 7.5$초) 
결국 **5초~7초를 요청하면 7.5초~9.5초 구간**이 돌아옵니다.

키프레임이 목표 근처에 있으면 세는 장 수가 줄어 오차도 줄지만, ②에서 착지 번호를 `시각 × fps`로 추정하는 순간 다시 CFR 가정이 들어가므로 오차가 없어지지는 않습니다. 

## 5. 지금 다루는 영상이 VFR인지 확인하는 법

대처법은 영상이 CFR인지 VFR인지에 따라 달라지므로 지금 내가 다루고 있는 영상이 CFR인지 VFR인지를 판별해야합니다.
판별 방법은 `ffprobe`로 **프레임별 실제 PTS 간격**을 보면 됩니다.

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries frame=best_effort_timestamp_time -of csv=p=0 input.mp4 \
| awk 'NF && NR>1 { printf "%.3f\n", $1 - prev } NF { prev = $1 }' \
| sort | uniq -c | sort -rn
```

위 스크립트는 프레임 사이 간격(초)별로 개수를 세는 명령어입니다. 
예시 영상이라면 대략 다음과 같이 나옵니다.

```
    149 0.033     ← 30fps 구간
     75 0.067     ← 15fps 구간
```

- **CFR:** 간격 값이 한 가지(예: `0.033`)만 나옵니다.
- **VFR:** 여러 값이 섞여 나옵니다.

주의할 점이 두 가지 있습니다.

- **프레임 길이(`pkt_duration_time`)로 판별하면 안 됩니다.** 이 값은 인코더가 채워 넣은 값이라 실제 간격과 다를 수 있습니다. 반드시 **PTS의 차이**를 봐야 합니다.
- **필드 이름이 FFmpeg 버전마다 다릅니다.** 예전 글에 자주 나오는 `pkt_pts_time`은 FFmpeg 5.0에서 제거됐습니다. `best_effort_timestamp_time`은 4.x~7.x에서 모두 동작합니다.

더 빠른 1차 확인으로는 스트림 정보의 `r_frame_rate`(기준 FPS)와 `avg_frame_rate`(평균 FPS)를 비교하는 방법이 있습니다.
예시 영상이라면 `30/1`과 `45/2`(=22.5, 225장 ÷ 10초)로 다르게 나옵니다. 
둘이 다르면 VFR일 가능성이 높지만, 같다고 CFR이라는 보장은 없으므로 최종 판단은 위의 PTS 간격으로 합니다.

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=r_frame_rate,avg_frame_rate -of default=nw=1 input.mp4
```

## 6. VFR 영상 대처법

### 6.1. 키프레임으로 seek하고 PTS로 도착 판단하기 (PyAV)

VFR이라고 해서 원하는 시각의 프레임을 못 가져오는 것은 아닙니다. 
문제는 seek이 아니라 **도착했는지를 무엇으로 판단하느냐**입니다.

[PyAV](https://github.com/PyAV-Org/PyAV)로 FFmpeg를 직접 다루면 이 판단을 우리가 직접 할 수 있습니다. 
점프 자체는 OpenCV와 똑같이 FFmpeg의 키프레임 seek입니다. 
차이는 착지한 뒤입니다. 
OpenCV는 착지 지점부터 **장 수를 세어** 도착을 판단하지만,
PyAV는 디코딩한 프레임마다 실제 **PTS를 반환하므로** 그 값으로 도착을 판단할 수 있습니다.

```python
# 의사코드: 5초 ~ 7초 구간 추출
점프(5초 이전의 가장 가까운 키프레임)       # OpenCV와 같은 FFmpeg seek. 단, 시각을 그대로 넘김
frames = []
for frame in 거기서부터_한_장씩_디코딩():
    t = frame.pts × time_base              # 이 프레임의 실제 시각(초)
    if t < 5.0: continue                   # 키프레임 ~ 5초 사이는 버림
    if t > 7.0: break                      # 장 수가 아니라 "시각"으로 도착 판단
    frames.append((t, frame))
```

예시 영상이라면 0초 키프레임에 착지하는 것까지는 OpenCV와 같습니다. 
하지만 장 수를 세지 않고 PTS를 보므로, 75번(5.0초)에서 시작해 135번(7.0초)에서 정확히 멈춥니다.

다만 seek 결과를 그대로 믿지는 말고 **검증**을 붙이는 것이 안전합니다.

- **seek이 목표를 지나쳐 착지할 수 있습니다.** 인덱스가 없는 TS 같은 컨테이너에서는 "5초 이전"으로 점프하라고 했는데 5.2초에 착지하는 일이 생깁니다. 그러면 5.0~5.2초 프레임이 소리 없이 빠집니다. **첫 프레임의 시각이 목표보다 뒤라면** 처음부터 순차 디코딩(6.2)으로 돌아가는 식으로 대비합니다.
- **PTS가 0부터 시작한다는 보장이 없습니다.** 파일에 따라 첫 프레임의 PTS가 1~2초부터 시작하기도 합니다. 영상 시작 기준 시각이 필요하면 첫 PTS(`stream.start_time`)를 빼서 씁니다.

검증까지 포함한 실제 코드는 [부록](#appendix)에 있습니다.

### 6.2. 처음부터 순차 디코딩하기

6.1이 기본이고, 처음부터 한 장씩 디코딩하는 방법은 **대비책**입니다. 
대신 seek에 전혀 의존하지 않으므로 어떤 파일에서도 확실합니다.

```python
# 의사코드: 5초 ~ 7초 구간 추출
frames = []
for frame in 영상을_처음부터_한_장씩_디코딩():
    t = frame의_실제_PTS           # OpenCV라면 cap.get(CAP_PROP_POS_MSEC)
    if t < 5.0:
        continue                  # 구간 전: 디코딩만 하고 버림
    if t > 7.0:
        break                     # 구간 끝: 종료
    frames.append((t, frame))     # 시각과 함께 저장
```

구간 앞부분도 전부 디코딩해야 하므로, 1시간짜리 영상의 50분 지점을 자르려면 50분 분량을 디코딩해야 합니다. 
그래서 다음 경우에만 사용합니다.

- **seek을 믿을 수 없는 파일:** TS 녹화본, 브라우저에서 녹화한 WebM, 녹화 도중 끊긴 파일처럼 키프레임 위치 정보가 없거나 깨진 파일입니다. 6.1의 검증에 걸렸을 때 돌아오는 곳이기도 합니다.
- **"N번째 프레임"이 필요할 때:** PTS로 seek하면 시각은 정확히 찾지만 그 프레임이 몇 번째인지는 알 수 없습니다. 번호는 앞에서부터 세야 합니다.
- **어차피 영상 전체를 분석할 때:** 녹화본 전체에 모델을 돌리는 작업이라면 seek로 아낄 것이 없습니다.
- **OpenCV만 쓸 수 있을 때:** OpenCV의 seek는 4절처럼 장 수로 도착을 판단하므로, OpenCV로 정확한 구간을 얻으려면 이 방법뿐입니다. 순차로 읽는 동안의 `CAP_PROP_POS_MSEC`는 실제 PTS를 돌려주므로 믿을 수 있습니다.

> **"시작 시점에 화면에 보이던 프레임"이 필요하다면**
>
> VFR에서는 요청한 시각에 정확히 걸린 프레임이 없는 경우가 많습니다. 프레임이 4.5초와 5.0초에만 있다면, 4.8초에 화면에 보이고 있는 것은 4.5초 프레임입니다. 이 프레임까지 포함하려면 구간 전의 마지막 프레임을 기억해 뒀다가 앞에 붙이면 됩니다. (6.1, 6.2 모두 해당)

OpenCV로 바로 쓸 수 있는 코드는 [부록](#appendix)에 있습니다.

### 6.3. 분석 전에 CFR로 변환하기

파이프라인 전체를 CFR 전제로 단순하게 유지하고 싶다면, 분석 전에 FFmpeg로 VFR영상을 CFR 영상으로 변환합니다.

```bash
# 30fps CFR로 변환 (FFmpeg 5.1 이상)
ffmpeg -i input_vfr.mp4 -fps_mode cfr -r 30 output_cfr.mp4

# FFmpeg 5.0 이하에서는 -fps_mode 대신 -vsync
ffmpeg -i input_vfr.mp4 -vsync cfr -r 30 output_cfr.mp4
```

`-fps_mode cfr`은 1/30초 간격에 맞추기 위해 **프레임을 복제하거나 버립니다.**
예시 영상이라면 15fps 구간의 프레임이 한 장씩 복제되어 150장이 되고, 반대로 30fps보다 촘촘한 구간이 있었다면 그 구간의 프레임이 버려집니다. 즉,

- 복제된 프레임은 **새 정보가 없는** 프레임입니다. 프레임 수 기반 통계(예: "N프레임 이상 등장")나 학습 데이터 샘플링이 복제 프레임에 의해 부풀려집니다.
- 버려진 프레임에만 찍힌 순간(빠르게 지나간 사람의 얼굴 등)은 사라집니다.
- 재인코딩이므로 화질 손실과 변환 시간이 추가됩니다.

그래서 **원본 VFR 파일은 반드시 따로 보관**하는 것을 권장합니다. 
나중에 다른 FPS가 필요해지거나, 분석 결과가 이상할 때 "변환 과정에서 생긴 문제인지 원본의 문제인지"를 가르려면 원본이 있어야 합니다.

### 6.4. 하드웨어 디코딩 (NVIDIA NVDEC)

위 방법들은 모두 "어느 프레임을 꺼낼지"를 바로잡는 방법이고, 속도 문제는 별개입니다. 
순차 디코딩을 택했다면 디코딩 속도가 곧 처리량입니다.

FFmpeg와 OpenCV는 기본적으로 CPU로 디코딩합니다. 이후 단계에서 AI 모델이 GPU에서 돈다면, 디코딩된 프레임을 매번 CPU 메모리에서 GPU 메모리로 복사하는 비용까지 붙습니다. 
NVIDIA GPU에는 **NVDEC**이라는 전용 하드웨어 디코더가 있어, 이를 쓰면 CPU 부담 없이 디코딩할 수 있고 결과 프레임을 **처음부터 GPU 메모리에 둘 수** 있어 복사 비용도 줄어듭니다.

NVDEC은 다음과 같은 경로로 쓸 수 있습니다.

- FFmpeg: `ffmpeg -hwaccel cuda -hwaccel_output_format cuda -i input.mp4 …`
- Python: NVIDIA PyNvVideoCodec, NVIDIA DALI, TorchCodec(`device="cuda"`) 등

하드웨어 디코딩을 쓰더라도 **PTS 문제는 그대로**라는 점은 기억해야 합니다. 
어떤 도구를 쓰든 프레임마다 실제 PTS를 받아 기록해야 합니다.

## 7. VFR이 AI 모델에 끼치는 영향

프레임을 정확히 꺼냈다고 끝이 아닙니다.
많은 모델과 알고리즘이 **프레임 간격이 일정하다**는 가정을 암묵적으로 깔고 있습니다.

<a href="#" data-series-post="2026-09-12-smart-cctv-tracking.md">앞 글</a>에서 다룬 MOT의 Kalman Filter가 대표적입니다. 
SORT·DeepSORT 계열의 Kalman Filter는 보통 **등속 운동 모델**을 쓰고, 한 스텝을 "프레임 하나"로 둡니다.

$$\text{다음 위치} = \text{현재 위치} + \text{속도} \times 1\ (\text{프레임})$$

CFR에서는 한 스텝이 항상 1/30초라 문제가 없습니다. 
그런데 예시 영상처럼 15fps 구간과 30fps 구간이 섞여 있으면, 같은 속도로 걷는 사람이라도 15fps 구간에서는 한 스텝에 **2배** 거리를 움직입니다. 
네트워크 문제로 프레임이 몇 장 통째로 빠지면 차이는 더 커집니다.

필터는 평소만큼만 움직였을 거라고 예측하니, 예측 위치와 실제 검출 위치가 벌어집니다. 
그 결과 매칭에 실패해서 새 ID가 붙거나(ID Switch), 근처의 다른 사람과 잘못 이어집니다. 
트랙을 몇 프레임까지 살려 둘지 정하는 `max_age` 같은 값도 프레임 단위라서, 같은 "30프레임"이 15fps 구간에서는 2초, 30fps 구간에서는 1초를 뜻하게 됩니다.

더 곤란한 것은 **원인을 찾기 어렵다**는 점입니다. 
추적 성능을 떨어뜨리는 요인은 검출기, Re-ID, 가림, 조명 등 매우 많고, "입력 영상의 프레임 간격"은 우선순위가 낮은 용의자라 한참 뒤에야 의심받기 쉽습니다. 
앞에서 본 것처럼 VFR 문제는 에러를 내지 않기 때문에 더욱 그렇습니다.

대처는 두 방향입니다.

- **입력을 맞춘다:** 6.3처럼 CFR로 변환합니다. 다만 복제 프레임에서는 사람이 멈춘 것처럼 보이므로, 이것이 추적에 어떤 영향을 주는지 따로 확인해야 합니다.
- **모델이 실제 간격을 쓰게 한다:** 프레임마다 기록한 PTS로 실제 경과 시간을 계산해 Kalman Filter의 예측에 반영하고(`위치 + 속도 × 경과 시간`), `max_age` 같은 값도 프레임 수가 아니라 시간으로 정의합니다.

## 8. 그래도 VFR은 사라지지 않는다

애플리케이션 개발자나 AI 연구자 입장에서는 모든 영상이 CFR이면 편하겠지만, VFR은 저장 공간·전력·네트워크 측면의 실익이 분명해서 당분간 사라지지 않을 것입니다.
아래는 VFR 영상을 특히 자주 만나는 매체들입니다. 
이런 영상을 입력으로 받는 서비스나 모델을 만든다면 처음부터 VFR을 전제로 설계하는 편이 안전합니다.

### CCTV / NVR

- **왜 VFR인가:** 움직임 없는 구간의 프레임 수를 낮추는 녹화 설정, 저조도 노출, RTSP 스트림의 프레임 드롭과 지연이 겹칩니다. 수십~수백 대를 24시간 녹화하므로 저장 공간을 아끼려는 동기도 큽니다.
- **주로 만나는 곳:** 보안 관제, 매장 방문객 분석, 출입 통제 등
- **주의할 점:** 이벤트 발생 시각을 PTS로 기록해야 녹화 시각과 맞출 수 있습니다. 추적 모델은 프레임 간격이 일정하다는 가정(7절)을 점검해야 하고, 녹화본이 TS처럼 인덱스 없는 컨테이너로 들어오는 경우가 많아 seek를 특히 조심해야 합니다.

### 스마트폰 카메라

- **왜 VFR인가:** 어두운 곳에서는 노출 시간을 확보하려고 프레임 레이트가 자동으로 내려가고, 발열·배터리 상황에 따라서도 달라집니다. 
- **주로 만나는 곳:** 사용자가 직접 찍어 올리는 영상을 다루는 거의 모든 서비스, 숏폼·영상 편집 앱
- **주의할 점:** 속도·각속도·반복 횟수처럼 **시간으로 나누는 지표**가 특히 위험합니다. 프레임 수를 시간으로 착각하면 같은 동작도 촬영 환경(실내 조명 등)에 따라 다른 값이 나옵니다. 프레임 사이의 실제 경과 시간은 PTS로 계산해야 합니다.

### 화상회의 / WebRTC 녹화

- **왜 VFR인가:** WebRTC는 네트워크 대역폭과 CPU 상황에 맞춰 실시간으로 프레임 레이트를 낮춥니다. 브라우저의 `MediaRecorder`로 녹화한 WebM 파일도 VFR이고, 영상 길이 정보나 seek용 인덱스가 빠져 있는 경우가 많습니다.
- **주로 만나는 곳:** 회의 녹화 요약, 온라인 시험 감독, 원격 진료·상담 녹화, 화상 면접 분석
- **주의할 점:** 음성(STT 결과)과 영상(표정·시선 분석 결과)을 합칠 때 시각을 PTS 기준으로 맞춰야 합니다. 프레임 번호 기준으로 맞추면 대화 내용과 화면이 어긋납니다.

### 화면 / 게임 녹화

- **왜 VFR인가:** 화면에 변화가 없으면 새 프레임을 만들지 않는 방식으로 녹화하는 도구들이 있습니다. 같은 이유로 게임은 장면의 부하에 따라 렌더링 FPS 자체가 계속 변합니다. (OBS는 기본적으로 CFR로 녹화합니다.)
- **주로 만나는 곳:** 게임 플레이 하이라이트 추출, 화면 조작 에이전트(Computer Use)·UI 자동화 학습 데이터, 튜토리얼 영상 자동 생성
- **주의할 점:** 사용자 입력 로그(클릭·키 입력 시각)와 화면 프레임을 짝지어 학습 데이터를 만들 때, 프레임 번호로 짝지으면 입력과 화면이 어긋납니다. 둘 다 시각 기준으로 맞춰야 합니다.

결국 VFR은 "피해야 할 포맷"이라기보다 **데이터를 받는 쪽에서 항상 전제해야 할 조건**에 가깝습니다.
공통으로 지킬 원칙은 두 가지입니다. 
영상 파이프라인의 입구에서 프레임 간격을 확인하고(5절),
프레임마다 실제 PTS를 기록해 **다른 데이터와는 항상 시각 기준으로 맞추는** 습관을 들여야 합니다.

---

<a id="appendix"></a>

## 부록

### A. 실제로 동작하는 코드

본문의 의사코드를 바로 쓸 수 있게 옮긴 코드입니다. 아래 B의 실험 영상(MP4·MKV·TS)에서 모두 5.0~7.0초 구간을 정확히 추출하는 것을 확인했습니다.

**PyAV seek + 검증 (6.1)**

```python
import av


def _decode_range(video_path, start_sec, end_sec, seek_sec):
    with av.open(video_path) as container:
        stream = container.streams.video[0]
        tb, t0 = stream.time_base, (stream.start_time or 0)

        if seek_sec:  # seek_sec 이전의 가장 가까운 키프레임으로 점프
            container.seek(t0 + int(seek_sec / tb), stream=stream)

        frames, checked = [], False
        for frame in container.decode(stream):
            if frame.pts is None:
                raise ValueError("PTS가 없는 프레임")
            t = float((frame.pts - t0) * tb)          # 영상 시작 기준 시각(초)
            if not checked:
                checked = True
                if seek_sec and t > start_sec:        # 목표를 지나쳐 착지 → 실패 신호
                    return None
            if t < start_sec:
                continue
            if t > end_sec:
                break
            frames.append((t, frame.to_ndarray(format="bgr24")))
        return frames


def extract_frames_by_time_av(video_path, start_sec, end_sec, margin_sec=2.0):
    frames = _decode_range(video_path, start_sec, end_sec,
                           seek_sec=max(start_sec - margin_sec, 0.0))
    if frames is None:  # seek가 빗나가면 처음부터 순차 디코딩
        frames = _decode_range(video_path, start_sec, end_sec, seek_sec=None)
    return frames
```

**OpenCV 순차 디코딩 (6.2)**

```python
import cv2


def extract_frames_by_time(video_path, start_sec, end_sec):
    """[start_sec, end_sec] 구간의 (실제 시각, 프레임) 목록을 반환한다."""
    cap = cv2.VideoCapture(video_path, cv2.CAP_FFMPEG)
    if not cap.isOpened():
        raise IOError(f"영상을 열 수 없음: {video_path}")

    start_ms, end_ms = start_sec * 1000.0, end_sec * 1000.0
    frames, prev_ms = [], -1.0
    try:
        while cap.grab():                          # 디코딩만 하고 이미지 변환은 미룸
            t = cap.get(cv2.CAP_PROP_POS_MSEC)     # 이 프레임의 실제 PTS(ms)
            if t <= prev_ms:                       # PTS가 없거나 역행하면 중단
                raise ValueError(f"타임스탬프 이상: {prev_ms:.1f}ms → {t:.1f}ms")
            prev_ms = t

            if t < start_ms:
                continue
            if t > end_ms:
                break
            ok, frame = cap.retrieve()             # 구간 안에서만 BGR 이미지로 변환
            if ok:
                frames.append((t / 1000.0, frame))
    finally:
        cap.release()                              # 예외가 나도 해제
    return frames


def get_frame_by_index(video_path, target_index):
    """실제로 target_index번째(0부터)인 프레임을 반환한다."""
    cap = cv2.VideoCapture(video_path, cv2.CAP_FFMPEG)
    try:
        for _ in range(target_index + 1):
            if not cap.grab():
                return None                        # 영상 끝을 넘어감
        ok, frame = cap.retrieve()                 # 마지막으로 grab한 프레임을 이미지로
        return frame if ok else None
    finally:
        cap.release()
```

### B. 실험: 실제 OpenCV는 어떻게 동작하는가

본문의 설명은 이해를 위해 FPS를 30으로 고정해 단순화했습니다. 실제 OpenCV가 어떻게 동작하는지 확인하기 위해 VFR 영상을 직접 만들어 측정했습니다. (OpenCV 5.0.0 / 4.10.0, PyAV, FFmpeg 4.4)

**실험 영상** — 본문 예시보다 차이를 크게 해서, 앞 5초는 0.5초마다 한 장(2fps), 뒤 5초는 30fps로 만들었습니다. 각 프레임에는 자기 번호를 흑백 블록으로 새겨서, 디코딩된 이미지만 보고도 실제 몇 번째 프레임인지 알 수 있게 했습니다.

| 프레임 번호 | 0 ~ 9 | 10 ~ 159 |
| --- | --- | --- |
| 실제 시각(PTS) | 0.0, 0.5, …, 4.5초 | 5.000, 5.033, …, 9.967초 |
| 간격 | 500ms | 33.3ms |

```python
import av
import numpy as np
from fractions import Fraction

# 0~5초: 0.5초 간격(2fps), 5~10초: 1/30초 간격(30fps) → 총 160프레임
ts = [i * 0.5 for i in range(10)] + [5 + i / 30 for i in range(150)]

out = av.open("vfr.mp4", "w")
stream = out.add_stream("libx264", rate=30)
stream.width, stream.height, stream.pix_fmt = 320, 64, "yuv420p"
stream.time_base = stream.codec_context.time_base = Fraction(1, 90000)

for i, t in enumerate(ts):
    img = np.zeros((64, 320, 3), np.uint8)
    for b in range(8):                       # 프레임 번호를 8비트 블록으로 기록
        if (i >> b) & 1:
            img[:, b * 40:(b + 1) * 40] = 255
    frame = av.VideoFrame.from_ndarray(img, format="rgb24")
    frame.pts, frame.time_base = round(t * 90000), Fraction(1, 90000)
    for packet in stream.encode(frame):
        out.mux(packet)
for packet in stream.encode():
    out.mux(packet)
out.close()


def frame_index(img):                        # 이미지에서 프레임 번호 읽기
    return sum(1 << b for b in range(8) if img[32, b * 40 + 20].mean() > 127)
```

MKV와 TS 버전은 재인코딩 없이 컨테이너만 바꿔 만들었습니다.

```bash
ffmpeg -i vfr.mp4 -c copy vfr.mkv
ffmpeg -i vfr.mp4 -c copy vfr.ts
```

**결과** — 같은 영상을 세 컨테이너에 담아 OpenCV(FFmpeg 백엔드)로 seek한 결과입니다.

| 요청 | 정답 | MP4 | MKV | MPEG-TS |
| --- | --- | --- | --- | --- |
| `POS_MSEC = 5000` | #10 (5.000초) | **#73 (7.100초)** | **#73 (7.100초)** | #17 (5.233초) |
| `POS_MSEC = 7000` | #70 (7.000초) | **#102 (8.067초)** | #50 (6.333초) | #70 (7.000초) ✅ |
| `POS_FRAMES = 100` | #100 (8.000초) | #100 ✅ | **#48 (6.267초)** | #17 (5.233초) |
| `POS_FRAMES = 140` | #140 (9.333초) | **#113 (8.433초)** | **#129 (8.967초)** | #17 (5.233초) |
| `CAP_PROP_FRAME_COUNT` | 160 | 160 | 146 | 300 |
| `CAP_PROP_FPS` | (가변) | 14.63 | 14.63 | 30.0 |

관찰한 내용은 다음과 같습니다.

- **환산에 쓰는 FPS는 평균 FPS입니다.** OpenCV 소스(`cap_ffmpeg_impl.hpp`)의 `get_fps()`는 스트림의 `avg_frame_rate`를 돌려주고, MP4·MKV에서 보고된 값은 14.63이었습니다. 이 영상은 5.2초 전까지 키프레임이 0초에 하나뿐이라, `POS_MSEC = 5000`은 $5 \times 14.63 \approx 73$번으로 환산된 뒤 0번부터 73장을 세어 **실제 73번 프레임(7.1초)** 에 착지했습니다. 본문 4절의 예시와 같은 경로입니다.
- **프레임 번호로 요청해도 틀립니다.** OpenCV의 `seek()`는 프레임 번호를 다시 `번호 / FPS`초로 바꿔 키프레임을 찾고, 착지한 프레임의 번호를 `PTS × FPS`로 추정한 뒤 거기서부터 셉니다. 컨테이너에 프레임 인덱스가 있어도 이 번호 계산에는 쓰지 않습니다. 그래서 MP4에서도 `POS_FRAMES = 100`은 맞았지만 `140`은 113번에 착지했습니다. 이때 `cap.get(CAP_PROP_POS_FRAMES)`는 140을 보고해서, 틀렸다는 신호조차 없었습니다. TS에서는 seek가 거의 모두 어긋났습니다.
- **순차 읽기 중의 `CAP_PROP_POS_MSEC`는 세 컨테이너 모두에서 정확했습니다.** 반면 `i / fps`로 계산하면 73번 프레임이 4.99초로 나왔습니다(실제 7.10초).
- **`pkt_duration_time`은 실제 간격과 달랐습니다.** 0.5초 간격 구간에서도 `0.033333`으로 기록되어 있었습니다.
- **PyAV seek도 TS에서는 빗나갔습니다.** 0~4초 어디로 seek해도 5.2초에 착지했고, TS로 옮긴 영상은 첫 PTS가 0이 아니라 2.4초였습니다. 부록 A의 검증 로직은 이 두 경우 때문에 들어갔습니다.
- OpenCV 4.10에서도 MP4 결과는 똑같았습니다.

---

**출처 및 참고**

- OpenCV, [VideoCapture 문서](https://docs.opencv.org/4.x/d8/dfe/classcv_1_1VideoCapture.html) 및 FFmpeg 백엔드 구현 [cap_ffmpeg_impl.hpp](https://github.com/opencv/opencv/blob/4.x/modules/videoio/src/cap_ffmpeg_impl.hpp)
- FFmpeg, [ffmpeg 문서 — `-fps_mode`](https://ffmpeg.org/ffmpeg.html#Advanced-options), [ffprobe 문서](https://ffmpeg.org/ffprobe.html)
- [PyAV](https://github.com/PyAV-Org/PyAV) — FFmpeg의 Pythonic 바인딩
- ISO/IEC 14496-12 (ISO Base Media File Format) — MP4의 샘플 테이블(`stts`·`ctts`·`stss`)
- [tell-mia, 가변 프레임 레이트(VFR) 정리](https://tell-mia.tistory.com/46)
- [Cloudinary, Variable Frame Rate](https://cloudinary.com/glossary/variable-frame-rate)
- 같은 시리즈: <a href="#" data-series-post="2026-09-12-smart-cctv-tracking.md">Smart CCTV, 얼굴이 보이지 않는 구간은 누구인가</a> — 7절에서 다룬 Kalman Filter와 ID Switch
