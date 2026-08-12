import { sendInteraktTemplate } from "./interaktService.js";

export function getInteraktOtpConfigurationStatus() {
  return {
    templateConfigured: Boolean(
      String(process.env.INTERAKT_OTP_TEMPLATE_NAME || "").trim()
    ),
    templateName: String(process.env.INTERAKT_OTP_TEMPLATE_NAME || "").trim() || null,
    languageCode: String(process.env.INTERAKT_OTP_LANGUAGE_CODE || "en").trim(),
  };
}

export async function sendOtp(phone, otp) {
  const templateName = String(process.env.INTERAKT_OTP_TEMPLATE_NAME || "").trim();
  const languageCode = String(
    process.env.INTERAKT_OTP_LANGUAGE_CODE || "en"
  ).trim();
  if (!templateName) {
    throw new Error("INTERAKT_OTP_TEMPLATE_NAME is not configured");
  }

  // Interakt authentication templates require the same code in the body and
  // copy-code button. The OTP is intentionally never logged by this service.
  return sendInteraktTemplate({
    countryCode: "+91",
    phoneNumber: phone,
    callbackData: "customer-login-otp",
    template: {
      name: templateName,
      languageCode,
      bodyValues: [otp],
      buttonValues: { "0": [otp] },
    },
  });
}
