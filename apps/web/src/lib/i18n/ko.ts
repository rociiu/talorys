import type { Translation } from "./core";

/** Korean messages. Keys missing here fall back to English. */
export const ko = {
  "time.justNow": "방금",
  "time.inAMoment": "잠시 뒤",

  "settings.language": "언어",
  "settings.languageHint": "앱의 언어입니다. 서버가 보내는 알림은 영어로 유지됩니다.",
  "settings.languageSystem": "브라우저 기본값 ({language})",

  "login.tagline": "나만의 AI 에이전트. 나만의 클라우드.",
  "login.notConfigured": "이 배포에는 아직 소유자 비밀번호가 설정되지 않았습니다. {command}를 다시 실행해 설정을 마치세요.",
  "login.password": "비밀번호",
  "login.passwordPlaceholder": "소유자 비밀번호",
  "login.showPassword": "비밀번호 표시",
  "login.hidePassword": "비밀번호 숨기기",
  "login.unlock": "잠금 해제",
  "login.tryAgainIn": "{seconds}초 뒤에 다시 시도",
  "login.rateLimited": "시도 횟수가 너무 많습니다. 보안을 위해 로그인을 잠시 중단합니다.",
  "login.failed": "로그인할 수 없습니다.",
  "login.forgotPassword": "비밀번호를 잊으셨나요? 컴퓨터에서 다음 명령으로 재설정하세요.{lineBreak}{command}",
} as const satisfies Translation;
