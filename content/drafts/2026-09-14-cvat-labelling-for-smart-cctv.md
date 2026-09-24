---
title: "Smart CCTV 평가 데이터, CVAT으로 GT 쌓기"
date: 2026-09-14
category: ai
summary: Probe Quality Evaluation의 전제인 GT를 실제로 쌓는 과정을 CVAT으로 정리합니다. 분석 축을 먼저 정하고 라벨 스키마로 옮기는 법, immutable/mutable 속성이 왜 person_id와 blurred를 가르는지, track 모드와 보간으로 라벨링 비용을 줄이는 법, GPU 없이 CPU만으로 얼굴 검출기와 트래커를 붙이는 법, 그리고 궤적 중심의 export를 프레임 중심 평가 스키마로 뒤집는 변환까지 실제 영상과 실측 수치로 다룹니다.
tags: ["Smart CCTV", "CVAT", "Annotation", "Data Quality", "Computer Vision"]
---

> **TL;DR**
>
> Probe Quality Evaluation은 "CCTV 영상에 face bbox GT를 라벨링한 뒤"에서 시작합니다. 그 한 줄이 실제로는 이 글 전체 분량의 작업입니다.
>
> - **분석 축을 먼저 정하고 스키마를 짭니다.** `camera_id`를 남기지 않으면 카메라별 비교를 영원히 못 합니다. 라벨링을 다시 하는 것 외에는 방법이 없습니다.
> - **CVAT의 immutable/mutable 속성이 `person_id`와 `blurred`를 가릅니다.** 궤적 내내 고정인 값과 프레임마다 변하는 값은 저장 위치가 다릅니다.
> - **shape이 아니라 track으로 찍습니다.** 키프레임만 찍고 사이는 보간에 맡깁니다. 실측에서 **키프레임 100개가 박스 952개**가 됐습니다 — AI를 쓰지 않고도 작업량이 9.5분의 1입니다.
> - **자동 라벨링은 GPU 없이도 됩니다.** 얼굴 검출기는 CPU에서 77ms/frame이 나왔습니다. 다만 이 영상의 **역광 구간 119프레임에서 검출률은 0.0%** 였습니다. 그 결과를 그대로 GT로 삼으면 측정하려던 현상이 데이터에서 통째로 지워집니다.
> - **Image quality 기본값 70을 그대로 두면 안 됩니다.** 품질을 재려고 모으는 데이터를 도구가 먼저 열화시킵니다.
>
> 마지막 관문은 축을 뒤집는 일입니다. CVAT은 궤적(track) 중심으로 내보내고, 평가 코드는 프레임(frame) 중심으로 읽습니다.

## 1. 이 글의 범위

앞선 글 **「Smart CCTV, 문제는 알고리즘일까 영상 품질일까」** 에서 Probe Quality Evaluation의 측정 절차를 정리하면서, 그 전제로 GT 라벨링 스키마를 이렇게 제시했습니다.

```json
{
  "recording_id": "rec-001",
  "camera_id": "cam-001",
  "frames": [
    {
      "frame_number": 12165,
      "timestamp": 845.8019,
      "detections": [
        {
          "person_id": "person-001",
          "face_bbox": { "x": 305, "y": 214, "w": 28, "h": 36 },
          "occluded": false,
          "blurred": false
        }
      ]
    }
  ]
}
```

이 글은 **저 JSON을 실제로 만들어 내는 과정**만 다룹니다. 도구는 CVAT(Computer Vision Annotation Tool)입니다. 측정 지표나 분석 방법은 앞선 글에 있으므로 반복하지 않습니다.

### 1-1. 작업 대상 영상

아래 8초짜리 클립을 끝까지 라벨링합니다. **1202×626, 30fps, 238프레임, 인물 4명**입니다.

<figure style="margin:1.5rem 0;"><video src="/videos/cvat-labelling/source-clip.mp4" controls muted loop playsinline preload="metadata" style="width:100%;display:block;border-radius:4px;border:1px solid var(--light-border);"></video><figcaption style="font-size:0.82rem;color:#666;margin-top:0.5rem;line-height:1.5;">작업 대상 원본. 앞부분은 역광 실루엣이라 얼굴에 이목구비 정보가 거의 없고, 인물이 다가오면서 조명이 들어옵니다. 프라이버시 보호를 위해 실제 CCTV 영상이 아닌 애니메이션 장면으로 치환했습니다</figcaption></figure>

이 클립을 고른 이유는 **한 영상 안에 프로브 품질의 양 극단이 다 들어 있기 때문**입니다.

- **앞 119프레임**: 역광 실루엣. 얼굴 위치는 알 수 있지만 이목구비는 검은 덩어리입니다.
- **뒤 48프레임**: 조명이 들어와 이목구비가 드러납니다.

같은 사람, 같은 카메라, 같은 녹화본인데 **전반부 프레임은 신원 식별에 쓸 수 없고 후반부는 쓸 수 있습니다.** 프로브 품질을 재야 하는 이유가 이 한 영상에 그대로 있습니다.

CVAT을 고른 이유는 단순합니다. 이 작업에 필요한 네 가지가 한 도구 안에 다 있습니다.

| 필요한 것 | CVAT에서 |
| --- | --- |
| 영상을 프레임 단위로 넘기며 bbox 그리기 | 기본 기능 |
| 같은 사람에게 고정 ID 부여 | track + immutable 속성 |
| 프레임마다 달라지는 플래그(occluded/blurred) | mutable 속성 |
| 자동 라벨링으로 초안 만들기 | Nuclio 서버리스 함수 |

아래 내용은 전부 **CVAT v2.75.0**을 실제로 띄워서 확인한 것입니다. 버전이 다르면 UI 위치와 기본값이 달라질 수 있습니다.

## 2. 설치 — GPU 없이 CPU만으로

### 2-1. 최소 구성

전체 저장소를 clone하지 않아도 됩니다. 다만 **`docker-compose.yml` 하나만 받으면 안 됩니다.** 이 파일이 로컬 경로를 bind mount로 참조하기 때문에, 해당 파일이 없으면 traefik·vector·grafana 컨테이너가 기동에 실패합니다.

필요한 파일은 다음과 같습니다. 전부 같은 태그에서 받아야 합니다.

```bash
BASE=https://raw.githubusercontent.com/cvat-ai/cvat/v2.75.0

curl -sSfL -O "$BASE/docker-compose.yml"
curl -sSfL --create-dirs -o components/analytics/grafana_conf.yml \
                                                     "$BASE/components/analytics/grafana_conf.yml"
curl -sSfL --create-dirs -o components/analytics/vector/vector.toml \
                                                     "$BASE/components/analytics/vector/vector.toml"
for f in all_events management monitoring users_exceptions; do
  curl -sSfL --create-dirs -o "components/analytics/grafana/dashboards/$f.json" \
       "$BASE/components/analytics/grafana/dashboards/$f.json"
done
```

> **주의 — 인터넷에 흔한 안내 두 가지가 지금은 맞지 않습니다.**
>
> 1. `docker-compose.override.yml`을 함께 받으라는 안내가 많은데, **이 파일은 업스트림 저장소에 존재하지 않습니다** (v2.75.0 기준 404). override가 필요하면 직접 작성해야 합니다.
> 2. `develop` 브랜치에서 받으라는 안내도 흔합니다. `develop`은 언제든 바뀌므로 **릴리스 태그로 고정**하는 편이 낫습니다.

### 2-2. 포트를 바꿔야 한다면

CVAT은 traefik을 통해 호스트 **8080** 포트로 나옵니다. 이미 쓰고 있는 포트라면 override 파일로 바꿉니다. compose가 자동으로 병합합니다.

```yaml
# docker-compose.override.yml
services:
  traefik:
    ports: !override
      - 8081:8080
```

`!override`가 없으면 기존 `8080:8080` 매핑에 새 매핑이 **추가**되어 포트 충돌이 그대로 남습니다.

`.env`의 `CVAT_HOST`는 traefik의 `Host()` 라우팅 규칙에만 쓰이고 **포트는 매칭 대상이 아니므로**, 포트를 바꿔도 `localhost` 그대로 두면 됩니다.

```bash
docker compose up -d
docker exec -it cvat_server bash -ic 'python3 ~/manage.py createsuperuser'
```

### 2-3. 자동 라벨링(Nuclio) 붙이기

자동 라벨링은 별도 compose 파일을 얹어야 켜집니다.

```bash
curl -sSfL --create-dirs -o components/serverless/docker-compose.serverless.yml \
     https://raw.githubusercontent.com/cvat-ai/cvat/v2.75.0/components/serverless/docker-compose.serverless.yml
```

파일을 매번 `-f`로 나열하기 번거로우니 `.env`에 못 박아 둡니다. **`COMPOSE_FILE`을 지정하면 override 자동 병합이 꺼지므로 override도 명시해야 합니다.**

```bash
# .env
CVAT_VERSION=v2.75.0
CVAT_HOST=localhost
COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:components/serverless/docker-compose.serverless.yml
```

함수를 배포하려면 Nuclio CLI(`nuctl`)가 필요합니다. **dashboard와 버전을 맞춰야 합니다** — v2.75.0은 `quay.io/nuclio/dashboard:1.16.3`을 씁니다.

```bash
curl -sSfL -o ~/.local/bin/nuctl \
  https://github.com/nuclio/nuclio/releases/download/1.16.3/nuctl-1.16.3-linux-amd64
chmod +x ~/.local/bin/nuctl
```

> **업스트림 `serverless/deploy_cpu.sh`를 그대로 돌리지 마세요.** 이 스크립트는 `serverless/` 아래 **모든** `function.yaml`을 배포합니다. SAM, YOLOv7, detectron2, mask-rcnn까지 전부 빌드하면서 디스크를 수십 GB 소모합니다. 필요한 함수의 경로만 배열에 적어 두고 그 둘만 도는 스크립트를 따로 쓰는 편이 낫습니다.

## 3. 라벨 스키마 — 분석 축을 먼저 정한다

라벨링을 시작하기 전에 **"나중에 어떤 축으로 grouping해서 볼 것인가"** 를 정해야 합니다. 이건 되돌릴 수 없는 결정입니다. `camera_id`를 남기지 않은 채 3만 프레임을 라벨링하고 나면, 카메라별 비교를 하려면 라벨링을 다시 하는 수밖에 없습니다.

평가 스키마의 각 필드를 CVAT의 어느 요소로 옮길지 먼저 정리합니다.

| 평가 스키마 필드 | CVAT에서 담는 곳 | 이유 |
| --- | --- | --- |
| `recording_id`, `camera_id` | **Task 이름** | 영상 하나 = task 하나. 라벨 속성으로 넣으면 모든 박스에 중복 저장된다 |
| `frame_number`, `timestamp` | 자동 | CVAT이 프레임 번호를 관리한다. timestamp는 fps로 환산 |
| `person_id` | **immutable 속성** (text) | 궤적 내내 고정 |
| `face_bbox` | rectangle shape | — |
| `occluded` | CVAT **내장** occluded 플래그 | 프레임마다 변함 |
| `blurred` | **mutable 속성** (checkbox) | 프레임마다 변함 |
| 신원 확정 여부 | **immutable 속성** (checkbox) | 궤적 단위 판단 |

### 3-1. immutable과 mutable의 차이가 핵심이다

CVAT 속성에는 `Mutable` 체크박스가 있습니다. 이름만 보면 사소해 보이지만, **속성이 track에 붙느냐 개별 box에 붙느냐**를 결정합니다.

- **Immutable**: 값이 track 전체에 하나. 한 번 정하면 모든 프레임에 같은 값이 적용됩니다.
- **Mutable**: 값이 프레임(box)마다 따로. 프레임을 넘기며 값을 바꿀 수 있습니다.

`person_id`를 mutable로 만들면 같은 사람의 궤적 중간에서 ID가 바뀌어도 CVAT이 막지 않습니다. 라벨러의 실수 하나가 Intra-pair를 Inter-pair로 둔갑시키고, 지표는 조용히 틀립니다. **immutable은 편의 기능이 아니라 데이터 무결성 장치입니다.**

반대로 `blurred`를 immutable로 만들면 "이 사람은 영상 내내 흐릿함"이라는 이분법만 남습니다. 이 글의 영상처럼 **전반부는 실루엣, 후반부는 선명한** 경우 그 변화를 기록할 방법이 사라지고, 프레임 선별의 근거도 함께 사라집니다.

![CVAT 프로젝트 라벨 편집 화면. 라벨 이름은 face, 형태는 Rectangle, 색상은 노란색이다. 그 아래 속성 세 줄이 있다. 첫 줄은 person_id, 타입 Text, Default value 비어 있음, Mutable 체크박스가 꺼져 있다. 둘째 줄은 blurred, 타입 Checkbox, 기본값 false, Mutable 체크박스가 켜져 있다. 셋째 줄은 identity_known, 타입 Checkbox, 기본값 true, Mutable 체크박스가 꺼져 있다. 아래에 파란색 Done 버튼과 빨간색 Cancel 버튼이 있다](/images/cvat-labelling/label-schema.png)

*`person_id`와 `identity_known`은 Mutable 해제(궤적 단위), `blurred`만 Mutable 설정(프레임 단위)*

같은 스키마를 Raw JSON으로 직접 붙여 넣을 수도 있습니다. 프로젝트를 여러 개 만들 때는 이쪽이 빠릅니다.

```json
[
  {
    "name": "face",
    "color": "#ffcc00",
    "type": "rectangle",
    "attributes": [
      { "name": "person_id",      "mutable": false, "input_type": "text",
        "values": [""],      "default_value": "" },
      { "name": "blurred",        "mutable": true,  "input_type": "checkbox",
        "values": ["false"], "default_value": "false" },
      { "name": "identity_known", "mutable": false, "input_type": "checkbox",
        "values": ["true"],  "default_value": "true" }
    ]
  }
]
```

### 3-2. 속성은 "측정 가능한 규칙"으로 정의한다

`blurred` 같은 주관적 플래그를 라벨러에게 그냥 맡기면 사람마다 기준이 달라집니다. **판정 규칙을 숫자로 적어 두어야** 라벨러가 여럿이어도 일관됩니다.

이 영상에서는 이렇게 정했습니다.

> **박스 내부에서 어두운 절반의 픽셀만 골라 휘도 표준편차를 계산하고, 18 미만이면 `blurred`.**
> 역광 실루엣은 얼굴 안쪽이 균일하게 어두워 편차가 작고, 조명이 들어오면 이목구비 음영이 생겨 편차가 커집니다.

실제로 이 기준은 구간을 깨끗하게 가릅니다.

| 구간 | 어두운 절반 픽셀의 휘도 표준편차(중앙값) |
| --- | --- |
| 역광 실루엣 (f0~119) | **12.1** |
| 중간 (f120~189) | 12.2 |
| 조명 들어온 뒤 (f190~237) | **26.7** |

처음에는 박스 전체의 휘도 표준편차를 쓰려다 실패했습니다. **역광 구간이 오히려 더 큰 값(79.6)** 이 나왔기 때문인데, 검은 실루엣과 밝은 하늘의 대비가 그대로 잡혀서였습니다. 얼굴 *안쪽* 정보를 재려면 배경을 빼고 봐야 합니다.

### 3-3. 신원 미확정을 스키마에 넣는다

앞선 글에서 "특정 인물로 확정할 수 없는 얼굴은 따로 라벨링한 후 지표에서 제외해야 한다"고 정리했습니다. 이걸 **라벨러의 메모가 아니라 스키마의 필드로** 만들어야 합니다.

`identity_known` 체크박스를 두고, 라벨러가 확신하지 못하면 해제하게 합니다. 변환 단계에서 이 값이 `false`인 궤적은 `person_id`를 `unknown`으로 내려 Intra/Inter 쌍 계산에서 자동으로 빠지게 합니다. 라벨러에게 "애매하면 비워 두세요"라고 말로 전달하는 방식은 반드시 샙니다.

> 이 글의 영상은 후반부에서 네 명 모두 얼굴이 드러나므로 `identity_known`은 전부 `true`입니다. **궤적이 이어져 있으면 선명한 구간 하나로 전 구간의 신원이 확정된다** — 이게 전신 추적으로 궤적을 먼저 잇는 이유이기도 합니다.

## 4. Task 만들기 — 기본값 하나가 데이터를 망친다

Task는 **영상 하나 = task 하나**로 만듭니다. 이름에 `recording_id`와 `camera_id`를 넣으면 (`rec-001_cam-01`) 변환 단계에서 파싱할 수 있고, task 목록 자체가 커버리지 현황표가 됩니다.

그리고 Task 생성 화면의 **Advanced configuration**을 반드시 펼쳐야 합니다.

| 항목 | 기본값 | Probe Quality용 권장 |
| --- | --- | --- |
| **Image quality** | **70** | **95~100** |
| Frame step | 1 | 영상이 길면 조정 |
| Segment size | 전체 | 라벨러가 여럿이면 분할 |

### 4-1. Image quality 70의 의미

CVAT은 업로드한 영상을 **JPEG로 재인코딩해서** 라벨러 화면에 뿌립니다. 그 품질의 기본값이 70입니다.

다른 작업이면 문제되지 않습니다. 하지만 우리가 모으는 데이터는 **"이 영상에 신원 정보가 남아 있는가"를 재기 위한 것**입니다. 도구가 먼저 화질을 깎아 버리면, 측정하려던 대상이 측정 전에 훼손됩니다.

이 영상의 실제 프레임으로 재인코딩 손실을 재 봤습니다. **얼굴 영역만** 따로 계산한 값이 오른쪽 열입니다.

| JPEG 품질 | 파일 크기 | 전체 프레임 PSNR | **GT 얼굴 영역 PSNR** |
| --- | --- | --- | --- |
| **70 (기본값)** | 69KB | 40.5 dB | **36.8 dB** |
| 85 | 98KB | 42.6 dB | 39.0 dB |
| **95** | 177KB | 44.9 dB | **41.8 dB** |
| 100 | 374KB | 48.2 dB | 45.5 dB |

*근경 프레임(f220, 얼굴 약 47px) 기준. 원경 프레임(f59, 얼굴 약 33px)에서도 q70 얼굴 37.5 dB → q95 얼굴 42.9 dB로 같은 폭의 차이가 납니다*

두 가지가 보입니다.

1. **얼굴 영역은 항상 전체 프레임보다 3~4 dB 나쁩니다.** 압축 손실은 고주파 성분에 몰리는데, 수십 픽셀짜리 얼굴은 거의 전부가 고주파이기 때문입니다.
2. **기본값 70과 권장값 95의 차이가 얼굴 영역에서 5 dB입니다.** 하필 판정이 갈리는 부분만 골라서 나빠집니다.

### 4-2. 원본은 남아 있다

다행히 CVAT은 원본도 함께 보관합니다. API에서 `quality` 파라미터로 골라 받을 수 있습니다.

```bash
# 라벨러가 보는 압축본 (JPEG)
curl -H "Authorization: Token $TOK" \
  "http://localhost:8080/api/jobs/2/data?type=frame&number=220&quality=compressed"

# 원본 (PNG)
curl -H "Authorization: Token $TOK" \
  "http://localhost:8080/api/jobs/2/data?type=frame&number=220&quality=original"
```

`image_quality=95`로 만든 task에서 같은 프레임을 둘 다 받아 보면 압축본 175KB(JPEG) / 원본 926KB(PNG), 둘 사이 PSNR 43.1 dB였습니다. 눈으로는 구분되지 않지만 **손실이 있는 건 분명합니다.**

> **규칙으로 정해 두면 좋은 것**
>
> 품질 점수(FIQA, 해상도, blur 지표)는 **CVAT이 뿌려 주는 프레임이 아니라 원본 영상에서 계산합니다.** CVAT은 bbox 좌표와 ID를 얻는 도구로만 쓰고, 픽셀은 원본에서 다시 읽는 편이 안전합니다. Image quality를 올리는 건 라벨러가 작은 얼굴을 제대로 볼 수 있게 하기 위한 것이지, 그 프레임으로 지표를 계산하라는 뜻이 아닙니다.

## 5. 라벨링 — AI 없이, track 모드로

이 절은 **AI를 전혀 쓰지 않고 사람이 직접 찍는 방법**입니다. 자동 라벨링은 6절에서 다루는데, 순서를 이렇게 둔 데는 이유가 있습니다. **track 모드를 제대로 쓰면 AI 없이도 라벨링 비용이 10분의 1로 떨어지기 때문**입니다. 자동 라벨링은 그 다음에 고민할 문제입니다.

### 5-1. Shape 모드와 Track 모드

CVAT에서 객체를 만들 때는 **도구를 활성화하는 시점에** 두 모드 중 하나를 고릅니다.

![CVAT의 Draw new rectangle 팝오버. Label 드롭다운에 face가 선택되어 있고, Drawing method로 2 Points / 4 Points 선택과 Rotated 체크박스가 있다. 맨 아래에 Shape 버튼과 Track 버튼이 나란히 있다](/images/cvat-labelling/draw-shape-or-track.png)

*도구를 켤 때 Shape / Track 중 하나를 누릅니다. 이 선택이 이후 작업 전체를 가릅니다*

둘의 차이는 이렇습니다.

![Shape 모드와 Track 모드를 비교한 도식. 위쪽 Shape 모드는 frame 0부터 frame 4까지 다섯 개의 프레임 상자가 떨어져 있고 각 상자 안의 파란 사각형에 face 1, face 2, face 3, face 4, face 5 처럼 서로 다른 ID가 붙어 있다. 아래쪽 Track 모드는 같은 다섯 프레임이 주황색 선으로 이어져 있고 모든 상자의 사각형에 face 1 이라는 같은 ID가 붙어 있다](/images/cvat-labelling/shape-vs-track.png)

- **Shape 모드**: 프레임마다 **별개의 객체**입니다. 프레임을 넘기면 앞 프레임의 객체는 사라지고, 새로 그린 것은 새 ID를 받습니다.
- **Track 모드**: 영상 전체에서 **하나의 객체**입니다. ID가 유지되고, 키프레임 사이는 **보간(interpolation)** 으로 채워집니다.

Probe Quality 데이터에서는 **반드시 track**입니다. 이유는 두 가지입니다.

1. `person_id`가 궤적에 한 번만 붙습니다. shape으로 찍으면 프레임마다 ID를 다시 입력해야 하고, 오타가 곧 ID 오류가 됩니다.
2. 라벨링 비용이 크게 줄어듭니다.

실제로 재 봤습니다. 238프레임 영상에서 **track 4개 × 키프레임 25개 = 100개**만 찍고 내보내니, XML에는 **박스 952개**가 들어 있었습니다. 사람이 찍은 건 100개, 나머지 852개는 CVAT이 보간으로 채운 값입니다. **9.5배**입니다.

### 5-2. 키프레임과 보간

보간은 **두 키프레임 사이의 빈 프레임을 선형으로 채워 주는** 기능입니다. 대상이 등속으로 움직이는 구간이라면 처음과 끝 두 개만 찍어도 사이가 전부 채워집니다.

![키프레임과 보간, outside를 설명한 도식. 위쪽 타임라인에는 일정 간격의 큰 주황색 점(키프레임)과 그 사이를 채우는 작은 흰 점(보간 프레임)이 찍혀 있고, 가운데 한 구간이 빨간 사각형으로 묶여 outside 화면에서 사라진 구간이라고 표시되어 있다. 그 구간이 시작되는 지점의 점은 빨간색이며 outside=1 유령 박스라는 설명이 붙어 있다. 아래쪽 타임라인에는 중간에 초록색 점 하나가 추가되어 있고 여기서 박스를 손보면 앞뒤 보간이 다시 계산된다는 설명이 붙어 있다](/images/cvat-labelling/keyframe-interpolation.png)

**중간 프레임에서 박스를 옮기면 그 프레임이 새 키프레임이 되고, 앞뒤 보간이 다시 계산됩니다.** 그래서 작업 순서가 "성기게 찍고 → 어긋난 곳만 손본다"가 됩니다. 처음부터 모든 프레임을 찍을 이유가 없습니다.

현재 프레임이 키프레임인지는 **별표(★)가 채워졌는지**로 구분합니다. 실제로 확인해 보면 이렇습니다.

| 프레임 | 별표 상태 |
| --- | --- |
| 120 (키프레임) | **채워짐** |
| 125 (보간 프레임) | 비어 있음 |
| 130 (키프레임) | **채워짐** |

궤적 조작은 객체 패널의 버튼과 단축키로 합니다.

![CVAT 객체 패널 항목을 확대하고 버튼 네 개에 번호를 붙인 그림. 왼쪽에는 노란색 RECTANGLE TRACK 패널이 확대되어 있고 첫 줄의 이전 키프레임 버튼에 1번, 다음 키프레임 버튼에 2번, 둘째 줄의 outside 버튼에 3번, 별표 버튼에 4번 빨간 원 표시가 있다. 오른쪽에는 1 이전 키프레임 E, 2 다음 키프레임 R, 3 outside 전환 O, 4 이 프레임을 키프레임으로 K 라는 표가 있고 아래에 별표가 채워져 있으면 현재 프레임이 키프레임이라는 뜻이라는 설명이 있다](/images/cvat-labelling/object-item-buttons.png)

전체 단축키 중 track 작업에 실제로 쓰는 것만 추리면 이렇습니다. (`F1`로 전체 목록을 볼 수 있습니다)

| 단축키 | 동작 |
| --- | --- |
| `D` / `F` | 이전 / 다음 프레임 |
| `C` / `V` | Player step만큼 뒤로 / 앞으로 |
| `E` / `R` | 이전 / 다음 **키프레임**으로 점프 |
| `K` | 현재 프레임을 키프레임으로 토글 |
| `O` | `outside` 토글 |
| `M` / `Alt+M` | 궤적 병합 / 분할 |

`E`·`R`이 특히 중요합니다. 보간이 잘 맞는 구간은 건너뛰고 **내가 찍은 지점만 오가며** 검수할 수 있기 때문입니다.

### 5-3. Player step — 건너뛰며 찍기

움직임이 부드러운 구간에서는 한 프레임씩 넘길 이유가 없습니다. `Settings → Player → Player step`을 조정하고 `C`/`V`로 건너뛰면서 키프레임만 찍습니다.

![CVAT Settings 모달의 Player 탭. Player step 입력란에 10이 들어 있고 옆에 Number of frames skipped when selecting 이중 화살표 라는 설명이 있다. 아래에 Player speed Usual, Select canvas background color 버튼, Reset zoom·Rotate all images·Smooth image·Show deleted frames 체크박스가 있다](/images/cvat-labelling/player-step.png)

*기본값은 10입니다. 30fps 영상이라면 10프레임 = 약 0.33초 간격*

이 글의 GT도 10프레임 간격으로 찍었습니다. **step 값은 "이 간격으로 건너뛰어도 보간이 실제 움직임을 따라가는가"로 정합니다.** 인물이 등속으로 걸어오는 구간은 10이 충분했지만, 방향을 바꾸거나 가속하는 구간이라면 더 촘촘히 찍어야 합니다.

### 5-4. outside — 화면에서 사라질 때

대상이 기둥 뒤로 들어가거나 화면 밖으로 나가면 **궤적을 지우는 게 아니라 `outside`를 켭니다**(`O`). 다시 나타나면 그 프레임에서 끄면 됩니다. 궤적과 `person_id`는 그대로 유지되므로, 같은 사람이 다시 들어왔을 때 **새 ID를 만들지 않아도 됩니다.**

이게 track 모드의 핵심 이점입니다. shape 모드로 작업했다면 "사라졌다 나타난 사람이 아까 그 사람인지"를 매번 사람이 기억해서 같은 ID를 입력해야 합니다.

**`occluded`와 헷갈리면 안 됩니다.** 이름이 비슷하지만 의미가 완전히 다릅니다.

| 플래그 | 의미 | GT에서의 처리 |
| --- | --- | --- |
| `occluded` | 대상이 **화면에 있지만 일부 가려짐** | bbox를 남기고 플래그만 세움 |
| `outside` | 대상이 **화면에서 사라짐** | **해당 프레임의 GT에서 제외** |

사람이 기둥 뒤로 완전히 들어갔다 나오는 구간은 `outside`입니다. 여기를 `occluded`로 처리하면 실제로는 존재하지 않는 얼굴에 bbox가 남아 **프로브 개수가 부풀려집니다.**

> `outside` 구간을 export할 때 함정이 하나 더 있습니다. 7-2절에서 다룹니다.

### 5-5. 궤적을 나누고 합치기

라벨링을 하다 보면 궤적이 잘못 이어지거나 끊깁니다. 왼쪽 툴바에 두 도구가 있습니다.

| 도구 | 툴팁 | 쓰는 때 |
| --- | --- | --- |
| **Merge shapes/tracks** (`M`) | `Merge shapes/tracks [M]` | 같은 사람인데 궤적이 둘로 나뉜 경우 합친다 |
| **Split a track** (`Alt+M`) | `Split a track [Alt+M]` | 한 궤적이 도중에 다른 사람으로 넘어간 경우 자른다 |

**Merge는 shape도 받습니다.** 툴팁 이름 그대로 `shapes/tracks`입니다. 그래서 급한 마음에 shape 모드로 찍어 버린 박스들도 나중에 하나의 track으로 묶을 수 있습니다. 다만 처음부터 track으로 찍는 편이 언제나 빠릅니다.

ID 오염은 지표를 조용히 망가뜨리는 종류의 오류입니다. 한 궤적이 도중에 다른 사람으로 넘어가면(ID switch), 그 구간의 Intra-pair가 사실은 Inter-pair가 되어 **"같은 사람인데 유사도가 낮다"는 가짜 신호**를 만듭니다. 검수 단계에서 `E`·`R`로 키프레임을 훑으며 이것부터 확인해야 합니다.

### 5-6. 실제 작업 순서

정리하면 이런 순서가 됩니다.

1. **Track 모드**로 첫 프레임에 박스를 그리고 `person_id`를 입력한다 (궤적당 한 번).
2. `V`로 Player step만큼 건너뛰며 **박스가 어긋난 지점에서만** 위치를 손본다. 손대는 순간 그 프레임이 키프레임이 된다.
3. 대상이 사라지는 구간에서 `O`로 `outside`를 켜고, 다시 나타나면 끈다.
4. `blurred` 같은 mutable 속성은 **값이 바뀌는 프레임에서만** 토글한다. 그 사이는 앞 키프레임 값이 유지된다.
5. `E`·`R`로 키프레임만 되짚으며 ID가 섞이지 않았는지, 박스가 대상을 자르지 않았는지 확인한다.

박스를 칠 때의 원칙도 몇 가지 있습니다.

- **대상을 타이트하게 감싸되 잘라내지 않는다.** 얼굴 해상도(`w`·`h`)가 그대로 품질 지표가 되므로, 박스가 크면 품질을 과대평가하게 됩니다.
- **일부 가려져도 보이는 부분은 전부 포함한다.** 이때는 박스를 남기고 `occluded`만 켭니다 — 대상이 아예 없는 `outside`와 다릅니다.
- **경계가 모호한 구간은 보간에 맡기지 않는다.** 인물이 겹치거나 급하게 움직이는 구간은 보간이 어긋나기 쉬우므로 프레임을 촘촘히 찍습니다.

### 5-7. 완성된 GT

<figure style="margin:1.5rem 0;"><video src="/videos/cvat-labelling/gt-tracks.mp4" controls muted loop playsinline preload="metadata" style="width:100%;display:block;border-radius:4px;border:1px solid var(--light-border);"></video><figcaption style="font-size:0.82rem;color:#666;margin-top:0.5rem;line-height:1.5;">완성된 GT. 궤적 4개가 238프레임 내내 끊기지 않고, <code>person_id</code>는 고정된 채 <code>blurred</code>만 프레임에 따라 바뀝니다. 인물이 다가오면서 얼굴 bbox가 29px에서 77px까지 커지는 것도 그대로 기록됩니다</figcaption></figure>

CVAT 화면에서는 이렇게 보입니다.

![CVAT 라벨링 화면. 왼쪽 캔버스에는 역광 실루엣 상태의 인물 네 명이 있고 각 얼굴에 노란색 bounding box가 그려져 있다. 오른쪽 사이드바에는 RECTANGLE TRACK 항목 네 개가 있고 그중 두 개가 펼쳐져 있다. 1번은 person_id가 person-001, blurred 체크됨, identity_known 체크됨이다. 2번은 person_id가 person-002, blurred 체크됨, identity_known 체크됨이다. 캔버스 가운데 선택된 박스 위에 FACE 2 (MANUAL) 36.4x38.9px person_id: person-002 blurred: true identity_known: true 정보가 떠 있다](/images/cvat-labelling/annotation-tracks.png)

*역광 구간(frame 120)이라 네 궤적 모두 `blurred: true`. 같은 궤적이 후반부로 가면 이 값만 `false`로 바뀌고 `person_id`는 그대로입니다*

> **한 가지 밝혀 둘 것.** 위 영상의 GT는 실제로는 6-2절의 트래커(TransT)로 만들었습니다. 다만 **결과물의 구조는 이 절에서 설명한 수동 작업과 완전히 같습니다** — track 4개, 궤적당 키프레임 25개, 나머지는 CVAT 보간. 트래커가 대신해 준 것은 "키프레임에서 박스를 옮기는 손동작"뿐이고, 모드 선택·`person_id` 부여·`blurred` 토글·검수는 그대로 사람 몫입니다.
>
> 그래서 **Nuclio를 설치하지 않았더라도 이 절의 절차만으로 같은 GT를 만들 수 있습니다.** 사람이 손대야 하는 지점은 952개가 아니라 100개입니다.

## 6. 자동 라벨링 — CPU로 어디까지 되는가

GPU 없이도 됩니다. 다만 **무엇을 자동화하고 무엇을 자동화하면 안 되는지**가 이 절의 핵심입니다.

### 6-1. 세 가지 선택지

| 방식 | GPU | Nuclio | 용도 |
| --- | --- | --- | --- |
| **TrackerMIL** (브라우저 내장) | ❌ | **불필요** | 가벼운 궤적 잇기 |
| **TransT** (Nuclio) | ❌ (CPU 빌드 제공) | 필요 | 정확한 궤적 잇기 |
| **face-detection-0205** (Nuclio) | ❌ (**CPU 전용**) | 필요 | 얼굴 bbox 초안 |

`face-detection-0205`는 OpenVINO 모델이고 저장소에 `function-gpu.yaml` 자체가 없습니다. 원래부터 CPU 전용입니다. TransT는 CPU/GPU 양쪽이 있고, CPU용 `function.yaml`이 `torch==1.13.1+cpu`를 설치합니다.

**TrackerMIL은 설치가 아예 필요 없습니다.** CVAT UI에 OpenCV.js가 번들되어 있어서 브라우저 안에서 돕니다. 서버 부하도, 배포 절차도 없습니다.

![CVAT 라벨링 화면 왼쪽 툴바의 OpenCV 팝오버. Drawing, Image, Tracking 세 탭 중 Tracking이 선택되어 있다. The tracker will be applied to drawn rectangles 라는 안내 문구 아래 Tracker 드롭다운에 TrackerMIL이 선택되어 있고 그 아래 Track 버튼이 있다](/images/cvat-labelling/opencv-tracker.png)

*OpenCV → Tracking → TrackerMIL. Nuclio를 배포하지 않아도 바로 쓸 수 있습니다*

Nuclio 함수를 배포하면 Models 페이지에 올라옵니다.

![CVAT Models 페이지. 카드 두 개가 나란히 있다. 왼쪽 카드는 Attributed face detection, System model 이라고 적혀 있고, 오른쪽 카드는 TransT, System model 이라고 적혀 있다](/images/cvat-labelling/models-deployed.png)

*CPU로 배포한 두 함수. 왼쪽이 얼굴 검출기(detector), 오른쪽이 트래커(tracker)*

### 6-2. 트래커 — GT를 만드는 데 실제로 썼다

이 글의 GT 궤적 4개는 **사람이 한 프레임에서 박스를 찍고 TransT가 나머지를 메우는** 방식으로 만들었습니다. 얼굴이 가장 또렷한 중간 프레임(f149)에서 박스 4개를 잡고, 앞뒤 양방향으로 전파했습니다. 트래커는 전방 추적만 하므로 앞 구간은 프레임 순서를 뒤집어 돌렸습니다.

| 항목 | 값 |
| --- | --- |
| 처리 속도 (4명 동시) | **2.8 s/frame** |
| 전체 238프레임 전파 | 663초 (약 11분) |
| ID 스왑 | 없음 (전 구간 4궤적 유지) |

프레임당 2.8초는 MOT를 통째로 돌리기에는 느립니다. 하지만 **라벨러가 키프레임 사이를 메우는 용도**로는 충분합니다. 어차피 사람이 결과를 확인하면서 넘어가기 때문입니다.

![CVAT AI Tools 패널의 Trackers 탭. Label 드롭다운에 face, Tracker 드롭다운에 TransT가 선택되어 있고 파란색 Track 버튼이 있다](/images/cvat-labelling/ai-tools-tracker.png)

### 6-3. 검출기 — 숫자가 말해 주는 것

같은 영상에 얼굴 검출기를 돌린 결과입니다.

| 항목 | 값 |
| --- | --- |
| 처리 속도 | **77 ms/frame** (1202×626, CPU) |
| 검출이 하나라도 있는 프레임 | 48/238 = **20.2%** |
| 검출 박스 총합 | **81개** (GT는 4명 × 238프레임 = **952개**) |
| 전체 recall | **8.5%** |

구간별로 쪼개면 그림이 훨씬 선명해집니다.

| 구간 | 검출된 프레임 | 박스 / GT | recall |
| --- | --- | --- | --- |
| **역광 실루엣 (f0~119)** | **0 / 119** | **0 / 476** | **0.0%** |
| 중간 (f120~189) | 4 / 70 | 4 / 280 | 1.4% |
| 조명 들어온 뒤 (f190~237) | 43 / 48 | 75 / 192 | 39.1% |

**역광 구간 119프레임에서 검출기는 얼굴을 단 하나도 찾지 못했습니다.**

<figure style="margin:1.5rem 0;"><video src="/videos/cvat-labelling/detector-output.mp4" controls muted loop playsinline preload="metadata" style="width:100%;display:block;border-radius:4px;border:1px solid var(--light-border);"></video><figcaption style="font-size:0.82rem;color:#666;margin-top:0.5rem;line-height:1.5;">얼굴 검출기(CPU) 출력. 앞부분 내내 "검출 0/4"가 이어지다가, 조명이 들어오는 후반부에 박스가 붙기 시작합니다. 위 GT 영상과 나란히 놓고 보면 <b>무엇이 데이터에서 사라지는지</b>가 그대로 보입니다</figcaption></figure>

### 6-4. 검출기를 붙이는 두 가지 위치

**작업 중 한 프레임씩**은 라벨링 화면의 AI Tools에서 씁니다.

![CVAT 라벨링 화면의 AI Tools 패널. Interactors, Detectors, Trackers 세 탭 중 Detectors가 선택되어 있다. Model 드롭다운에 Attributed face detection이 선택되어 있고, 그 아래 Setup mapping between labels and attributes 영역에 모델 라벨 face와 프로젝트 라벨 face가 노란색 칩으로 매핑되어 있다. 아래에 Threshold 입력란, Region of interest의 x·y·width·height 입력란, 파란색 Annotate 버튼이 있다](/images/cvat-labelling/ai-tools-detector.png)

*모델이 내놓는 라벨 `face`를 프로젝트 라벨 `face`에 매핑합니다. 이름이 같아도 매핑은 명시해야 합니다*

**작업 전 전체 일괄**은 Task 화면의 Actions → Automatic annotation입니다.

![CVAT의 Automatic annotation 모달. Model 드롭다운에 Attributed face detection이 선택되어 있고, 라벨 매핑 영역에 face와 face가 노란색 칩으로 연결되어 있다. Threshold 입력란과 Region of interest 입력란이 있고, Clean previous annotations 토글이 꺼져 있으며 오른쪽 아래에 파란색 Annotate 버튼이 있다](/images/cvat-labelling/auto-annotation.png)

*`Clean previous annotations`를 켜면 기존 라벨이 지워집니다. 사람이 이미 손본 task에서는 반드시 꺼 두어야 합니다*

### 6-5. 자동 라벨링 결과를 GT로 쓰면 안 되는 이유

여기가 이 글에서 가장 중요한 부분입니다.

검출기를 돌린 결과를 그대로 GT로 삼으면, 이 영상의 GT는 **952개가 아니라 81개**가 됩니다. 그리고 그 81개는 전부 조명이 들어온 뒤의 프레임에서 나옵니다.

그런데 Probe Quality Evaluation이 답하려는 질문은 바로 *"역광·원경에서 신원 식별이 되는가"* 입니다. 자동 라벨링은 **측정하려던 현상을 측정 전에 데이터에서 지웁니다.** 남은 데이터로 지표를 내면 "우리 CCTV는 프로브 품질이 좋다"는 결론이 나오는데, 이건 품질이 좋아서가 아니라 나쁜 프로브가 라벨링되지 않아서입니다.

게다가 이 편향은 **조용합니다.** 검출률이 0%였다는 사실은 GT 파일 어디에도 남지 않습니다. 프레임 수와 박스 개수만 보면 정상으로 보입니다.

> **자동 라벨링의 올바른 위치**
>
> 자동 라벨링은 **초안 생성기**이지 GT 생성기가 아닙니다. 검출 결과를 띄워 놓고 **사람이 빠진 얼굴을 채우고 잘못된 박스를 지우는** 과정이 반드시 있어야 합니다. 그리고 그 검수 과정에서 "검출기가 놓친 프레임"의 목록 자체가 귀중한 분석 자료입니다 — 운영 중인 파이프라인이 어디서 실패하는지 그대로 보여 주기 때문입니다.
>
> 반대로 **트래커는 상대적으로 안전합니다.** 사람이 첫 박스를 직접 찍어서 대상을 지정하고, 트래커는 그 대상을 따라가기만 하기 때문에 "대상이 통째로 누락되는" 편향이 생기지 않습니다. 실제로 이 글의 GT는 검출률 0%인 역광 구간에서도 트래커가 궤적 4개를 전부 유지했습니다.

## 7. 내보내기 — 축을 뒤집는다

라벨링이 끝나면 Task Actions → Export task dataset으로 내보냅니다.

![CVAT의 Export task as a dataset 모달. Export format 드롭다운이 열려 있고 CamVid 1.0, Cityscapes 1.0, COCO 1.0, COCO Keypoints 1.0, CVAT for images 1.1, CVAT for video 1.1, Datumaro 1.0, ICDAR Localization 1.0 항목이 보인다. CVAT for video 1.1이 선택되어 강조되어 있다](/images/cvat-labelling/export-format.png)

포맷 선택에 대해 "COCO로 내보내면 커스텀 속성이 날아간다"는 말이 흔히 돌지만, **v2.75.0에서 직접 확인해 보니 사실이 아니었습니다.** 같은 task를 세 포맷으로 내보내 비교한 결과입니다.

| 포맷 | 구조 | `person_id` 등 커스텀 속성 | 궤적 ID | bbox 좌표계 |
| --- | --- | --- | --- | --- |
| **CVAT for video 1.1** | track 중심 | 보존 (`<attribute>`) | `<track id>` | `xtl/ytl/xbr/ybr` |
| **COCO 1.0** | 이미지 중심 | 보존 (`attributes` 객체) | `attributes.track_id` | **`[x, y, w, h]`** |
| **CVAT for images 1.1** | 이미지 중심 | 보존 (`<attribute>`) | **없음** | `xtl/ytl/xbr/ybr` |

COCO 1.0의 annotation은 이렇게 나옵니다. `person_id`는 물론 `track_id`와 `keyframe`까지 들어 있습니다.

```json
{
  "id": 1, "image_id": 1, "category_id": 1,
  "bbox": [461.0, 236.0, 30.0, 40.0],
  "iscrowd": 0,
  "attributes": {
    "person_id": "person-001", "blurred": true, "identity_known": true,
    "occluded": false, "rotation": 0.0, "track_id": 0, "keyframe": true
  }
}
```

즉 **세 포맷 모두 이 작업에 쓸 수 있습니다.** 실제 차이는 다른 데 있습니다.

- **COCO 1.0은 이미 프레임 중심이고 bbox가 `[x, y, w, h]`** 입니다. 평가 스키마와 좌표계가 같아서 변환이 가장 짧습니다. 대신 프레임 번호를 `file_name`(`frame_000000.png`)에서 파싱해야 합니다.
- **CVAT for images 1.1은 궤적 ID가 없습니다.** 다만 `person_id`가 남으므로 Intra/Inter 쌍은 그대로 나눌 수 있습니다.
- **CVAT for video 1.1은 track 구조와 `outside` 경계를 명시적으로 남깁니다.** 아래에서 보듯 이게 함정이자 장점입니다.

아래에서는 CVAT for video 1.1을 기준으로 설명합니다. 궤적 단위 검수 이력을 같이 보기 좋기 때문인데, COCO를 골라도 결과 JSON은 동일하게 만들 수 있습니다.

### 7-1. 내보낸 XML의 구조

```xml
<track id="0" label="face" source="manual">
  <box frame="0" keyframe="1" outside="0" occluded="0"
       xtl="461.00" ytl="236.00" xbr="491.00" ybr="276.00" z_order="0">
    <attribute name="blurred">true</attribute>
    <attribute name="person_id">person-001</attribute>
    <attribute name="identity_known">true</attribute>
  </box>
  <box frame="1" keyframe="0" outside="0" occluded="0"
       xtl="461.30" ytl="235.80" xbr="491.20" ybr="275.70" z_order="0">
    ...
```

세 가지를 확인할 수 있습니다.

1. **보간이 이미 펼쳐져 있습니다.** `keyframe="0"`인 박스는 CVAT이 계산해 준 값입니다. 변환 스크립트가 보간을 다시 구현할 필요가 없습니다.
2. **immutable 속성도 모든 박스에 복사됩니다.** `person_id`가 box마다 들어 있어서, 프레임 단위로 읽을 때 track을 거슬러 올라갈 필요가 없습니다.
3. **좌표가 `xtl/ytl/xbr/ybr`(좌상단·우하단)입니다.** 평가 스키마의 `x/y/w/h`와 다르므로 변환이 필요합니다.

### 7-2. `outside`는 유령 박스를 남긴다

5절에서 `outside="1"`인 박스는 버려야 한다고 했습니다. 실제로 어떻게 나오는지 확인하려고, GT 궤적 하나에 **10프레임짜리 `outside` 구간(f100~109)** 을 일부러 만들고 세 포맷으로 내보냈습니다.

| 포맷 | track 0의 박스 수 | `outside` 구간 처리 |
| --- | --- | --- |
| **CVAT for video 1.1** | **229개** | 프레임 100에 **`outside="1"`인 박스가 남고**, 101~109는 없음 |
| COCO 1.0 | 228개 | 100~109 전부 생략, 마커 없음 |
| CVAT for images 1.1 | 228개 | 100~109 전부 생략 |

**CVAT for video 1.1만 경계 프레임에 마커 박스를 하나 남깁니다.** 좌표까지 들어 있는 정상적인 `<box>` 요소라서, `outside` 속성을 보지 않고 파싱하면 **실제로는 화면에 없는 얼굴이 프로브 하나로 집계됩니다.** 궤적이 끊겼다 이어지는 구간이 많은 CCTV 영상에서는 이런 유령 박스가 수백 개씩 쌓입니다.

아래 변환 스크립트가 `outside="1"`을 버리는 이유가 이것입니다.

### 7-3. 축 전환

남은 일은 데이터를 보는 축을 바꾸는 것입니다.

![CVAT의 궤적 중심 구조를 프레임 중심 구조로 바꾸는 과정을 그린 도식. 위쪽에는 person-001부터 person-004까지 네 개의 가로 타임라인이 0번부터 237번 프레임까지 그려져 있고, 각 타임라인에는 10프레임 간격의 큰 색점(사람이 직접 찍은 키프레임)과 그 사이를 메우는 작은 흰 점(CVAT이 자동으로 채운 보간 프레임)이 번갈아 찍혀 있다. 범례에 키프레임은 track 4개 곱하기 25개로 100개, 보간 프레임은 852개라고 적혀 있다. 가운데 아래쪽 화살표에 export 화살표 축을 뒤집는다 라고 적혀 있다. 아래쪽에는 frame 0 t=0.0000, frame 1 t=0.0333, frame 2 t=0.0667 세 개의 상자가 나란히 있고 각 상자 안에 person-001부터 person-004까지 네 개의 점이 들어 있다. 옆에 점점점 238 프레임이라고 적혀 있다](/images/cvat-labelling/track-to-frame.png)

*CVAT은 "사람 한 명이 어떻게 움직였나"로 저장하고, 평가 코드는 "이 순간에 누가 있었나"로 읽습니다*

```python
"""CVAT for video 1.1 (annotations.xml) -> Probe Quality Evaluation GT(JSON)."""
import argparse, json, xml.etree.ElementTree as ET


def convert(xml_path, recording_id, camera_id, fps):
    root = ET.parse(xml_path).getroot()
    frames = {}

    for track in root.iter("track"):
        if track.get("label") != "face":
            continue
        for box in track.iter("box"):
            # outside="1" 은 그 프레임에서 대상이 사라졌다는 표시 -> GT 에서 제외
            if box.get("outside") == "1":
                continue
            attrs = {a.get("name"): a.text for a in box.iter("attribute")}
            # 신원을 확정할 수 없는 얼굴은 person_id 를 unknown 으로 내려
            # Intra/Inter 쌍 계산에서 빠지게 한다
            known = (attrs.get("identity_known") or "true").lower() == "true"
            pid = attrs.get("person_id") or "unknown"
            if not known:
                pid = "unknown"

            x1, y1 = float(box.get("xtl")), float(box.get("ytl"))
            x2, y2 = float(box.get("xbr")), float(box.get("ybr"))
            fn = int(box.get("frame"))
            frames.setdefault(fn, []).append({
                "person_id": pid,
                "face_bbox": {"x": round(x1), "y": round(y1),
                              "w": round(x2 - x1), "h": round(y2 - y1)},
                "occluded": box.get("occluded") == "1",
                "blurred": (attrs.get("blurred") or "false").lower() == "true",
            })

    return {
        "recording_id": recording_id,
        "camera_id": camera_id,
        "frames": [
            {"frame_number": fn,
             "timestamp": round(fn / fps, 4),
             "detections": frames[fn]}
            for fn in sorted(frames)
        ],
    }


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("xml")
    p.add_argument("--recording-id", required=True)
    p.add_argument("--camera-id", required=True)
    p.add_argument("--fps", type=float, required=True)
    p.add_argument("-o", "--out", required=True)
    a = p.parse_args()
    out = convert(a.xml, a.recording_id, a.camera_id, a.fps)
    json.dump(out, open(a.out, "w"), indent=2, ensure_ascii=False)
    n = sum(len(f["detections"]) for f in out["frames"])
    print(f"{len(out['frames'])} frames, {n} detections -> {a.out}")
```

```bash
$ python3 cvat_to_probe.py annotations.xml \
    --recording-id rec-001 --camera-id cam-01 --fps 30 -o gt.json
238 frames, 952 detections -> gt.json
```

결과는 앞선 글의 스키마 그대로입니다.

```json
{
  "recording_id": "rec-001",
  "camera_id": "cam-01",
  "frames": [
    {
      "frame_number": 0,
      "timestamp": 0.0,
      "detections": [
        { "person_id": "person-001",
          "face_bbox": { "x": 461, "y": 236, "w": 30, "h": 40 },
          "occluded": false, "blurred": true },
        { "person_id": "person-002",
          "face_bbox": { "x": 537, "y": 246, "w": 26, "h": 25 },
          "occluded": false, "blurred": true },
        { "person_id": "person-003",
          "face_bbox": { "x": 618, "y": 227, "w": 31, "h": 38 },
          "occluded": false, "blurred": true },
        { "person_id": "person-004",
          "face_bbox": { "x": 709, "y": 248, "w": 36, "h": 31 },
          "occluded": false, "blurred": true }
      ]
    }
  ]
}
```

`fps`를 인자로 받는 이유는, **CVAT이 timestamp를 보존하지 않기 때문**입니다. CVAT은 프레임 번호만 관리합니다. Frame step을 1이 아닌 값으로 줬다면 `frame_number`가 원본 영상의 프레임 번호와 어긋나므로, 그 값도 함께 보정해야 합니다.

### 7-4. 변환 직후 확인할 것

변환이 끝나면 지표를 내기 전에 이것부터 봅니다.

```bash
$ python3 -c "
import json, collections, statistics
d = json.load(open('gt.json'))
c = collections.Counter(x['person_id'] for f in d['frames'] for x in f['detections'])
b = collections.Counter(x['blurred']   for f in d['frames'] for x in f['detections'])
w = [x['face_bbox']['w'] for f in d['frames'] for x in f['detections']]
print('person_id:', dict(c))
print('blurred  :', dict(b))
print(f'bbox 가로: 중앙값 {statistics.median(w):.0f}px (min {min(w)}, max {max(w)})')
"
person_id: {'person-001': 238, 'person-002': 238, 'person-003': 238, 'person-004': 238}
blurred  : {True: 778, False: 174}
bbox 가로: 중앙값 42px (min 26, max 77)
```

- **`unknown` 비율**: 앞선 글에서 짚었듯이, 제외된 얼굴 개수는 반드시 리포트에 남깁니다. 이 영상은 전부 신원이 확정되어 `unknown`이 0이지만, 실제 CCTV 데이터에서는 절반을 넘는 일이 흔합니다. 그 사실을 적어 두지 않으면 총 프로브 개수만 보고 표본이 충분하다고 오판하게 됩니다.
- **`blurred` 비율**: 952개 중 **778개(82%)** 가 실루엣 구간입니다. 쓸 만한 프로브는 174개뿐이라는 뜻이고, 이 숫자가 곧 "프레임 선별의 여지가 얼마나 되는가"입니다.
- **`face_bbox` 크기 분포**: 얼굴 해상도 자체가 품질 지표입니다. 중앙값이 42px이라면 그 카메라는 알고리즘을 바꿔서 해결할 대상이 아닙니다.
- **`person_id`별 프레임 수**: 네 명 모두 238로 같습니다. 특정 인물만 유독 적으면 궤적이 중간에 끊겼을 가능성이 큽니다.

## 8. 정리

Probe Quality Evaluation의 GT를 CVAT으로 쌓는 과정을 순서대로 놓으면 이렇습니다.

| 단계 | 결정할 것 | 틀리면 생기는 일 |
| --- | --- | --- |
| **스키마 설계** | 어떤 축으로 grouping할 것인가 | 라벨링을 처음부터 다시 |
| **속성 설계** | immutable / mutable, 판정 규칙의 수치화 | ID가 궤적 중간에 바뀌어도 못 잡음 |
| **Task 생성** | Image quality를 70에서 올린다 | 얼굴 영역이 압축으로 5 dB 손상 |
| **라벨링** | shape이 아니라 track, Player step으로 성기게 | 라벨링 비용 9.5배, ID 오타 위험 |
| **사라짐 처리** | 궤적을 지우지 말고 `outside` | 같은 사람에게 새 ID가 붙어 궤적이 쪼개짐 |
| **자동 라벨링** | 초안으로만 쓰고 사람이 검수 | 역광 구간이 통째로 누락, 편향은 무증상 |
| **내보내기** | 포맷별 구조 차이 확인 | 좌표계·프레임 번호 파싱을 잘못 맞춤 |
| **변환** | `outside` 제외, `identity_known` 반영 | 유령 박스가 프로브로 집계됨 |

되짚어 보면 실제 난이도는 도구 사용법에 있지 않았습니다. **어떤 필드를 남길지, 무엇을 자동화하지 않을지**를 정하는 판단에 있었습니다. CVAT 조작법은 하루면 익히지만, `camera_id`를 빠뜨린 3만 프레임은 되돌릴 방법이 없습니다.

특히 자동 라벨링은 유혹이 큽니다. 검출기를 한 번 돌리면 8초 영상이 20초 만에 처리됩니다. 하지만 그 결과는 952개 중 81개였고, 그중 역광 구간에서 나온 것은 **0개**였습니다. 평가 데이터에서 자동 라벨링의 실패는 **데이터 부족이 아니라 데이터 편향**으로 나타나고, 편향은 개수를 세는 것으로는 발견되지 않습니다. 검출기가 찾지 못한 871개야말로 이 평가가 보려던 대상입니다.

그리고 자동 라벨링을 걷어내도 track 모드만으로 충분히 빠릅니다. 이 영상에서 사람이 실제로 손대야 하는 지점은 952곳이 아니라 **100곳**이었습니다. 키프레임·보간·`outside`를 손에 익히는 것이 검출기를 붙이는 것보다 먼저입니다.

다음 글에서는 이렇게 쌓은 GT로 라벨러 간 일치도를 확인하고, 여러 카메라·녹화본에 걸쳐 커버리지를 관리하는 방법을 다루겠습니다.

## 참고 문헌

- CVAT, [Lecture 11. Track mode | Overview](https://www.youtube.com/watch?v=vzaFFfRFbb8) — YouTube
- CVAT, [Lecture 11. Track mode | Practical Task](https://www.youtube.com/watch?v=4c6zFssovNY) — YouTube
- [CVAT 공식 문서](https://docs.cvat.ai/docs/)
- 이 글의 모든 수치와 UI 동작은 **CVAT v2.75.0**을 직접 띄워 확인했습니다.
