# 웹 배포

이 프로젝트는 Vercel에 정적 사이트 + `/api/blueprint` 서버리스 함수로 배포할 수 있습니다.

## 1. Vercel 환경변수

Vercel 프로젝트의 **Settings → Environment Variables**에 다음을 넣습니다.

- `OPENAI_API_KEY` = 발급받은 OpenAI API 키
- `OPENAI_IMAGE_MODEL` = `gpt-image-2.5-sunburst`
- `OPENAI_IMAGE_QUALITY` = `medium`

API 키는 `index.html`에 넣지 않습니다.

## 2. 배포

`fourcut_inspect` 폴더를 GitHub에 올리고 Vercel에서 해당 저장소를 Import 합니다.
`index.html`이 있는 폴더를 프로젝트 루트로 선택하면 `/api/blueprint`도 자동 배포됩니다.

## 3. 행사장 자동 인쇄

웹사이트 자체에서는 프린터를 직접 제어할 수 없으므로 행사장 PC에서:

```bash
node server/print-server.js --tunnel
```

을 실행한 뒤 관리자 설정의 `자동 인쇄 서버 주소`에 터널 주소를 넣습니다.
이렇게 하면 웹에서 AI 생성은 `/api/blueprint`, 자동 인쇄와 QR 사진 수령은 행사장 PC가 맡습니다.

`--lan`을 사용하면 같은 Wi-Fi 안에서 QR 사진을 받을 수 있습니다.

## 4. 사진 필터

네컷 촬영 후 `네 장 고르기` 화면에서 `원본 / 흑백 / 필름 / 화사 / 선명`을 바로 선택할 수 있습니다.
인쇄 미리보기 화면에서도 같은 필터를 다시 바꿀 수 있으며, 선택 결과가 실제 인화 PNG에 반영됩니다.
