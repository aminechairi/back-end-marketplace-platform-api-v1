exports.verificationEmailTemplate = (fullName, code) => {
  return `
    <div
      style="
        font-family: Arial, Helvetica, sans-serif;
        color: #333;
        max-width: 600px;
        margin: 0 auto;
        padding: 30px 20px;
        text-align: center;
      "
    >
      <h1
        style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #222"
      >
        Hi ${fullName},
      </h1>

      <p style="margin: 0 0 20px 0; font-size: 16px; line-height: 1.5; color: #555">
        Thank you for registering with <strong>E-shop</strong>. To verify your email address, please use the following code:
      </p>

      <div
        style="
          background: #f8f9fa;
          border: 1px solid #e0e0e0;
          border-radius: 6px;
          padding: 16px;
          display: inline-block;
          margin-bottom: 24px;
        "
      >
        <h2
          style="
            margin: 0;
            font-size: 28px;
            font-weight: 700;
            letter-spacing: 2px;
            color: #2c7be5;
            color: #ff6a2f;
          "
        >
          ${code}
        </h2>
      </div>

      <p style="margin: 0 0 20px 0; font-size: 15px; color: #555">
        Enter this code in the verification page to complete your registration.
      </p>

      <p style="margin: 0; font-size: 14px; color: #777; line-height: 1.5">
        <strong>Note:</strong> This code will expire in 10 minutes. If you didn't request this, please ignore this email.
      </p>
    </div>
  `;
};

exports.forgotPasswordTemplate = (fullName, code) => {
  return `
    <div
      style="
        font-family: Arial, Helvetica, sans-serif;
        color: #333;
        max-width: 600px;
        margin: 0 auto;
        padding: 30px 20px;
        text-align: center;
      "
    >
      <h1
        style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #222"
      >
        Hi ${fullName},
      </h1>

      <p style="margin: 0 0 20px 0; font-size: 16px; line-height: 1.5; color: #555">
        We received a request to reset the password for your <strong>E-shop Account</strong>. Please use the following verification code to proceed:
      </p>

      <div
        style="
          background: #f8f9fa;
          border: 1px solid #e0e0e0;
          border-radius: 6px;
          padding: 16px;
          display: inline-block;
          margin-bottom: 24px;
        "
      >
        <h2
          style="
            margin: 0;
            font-size: 28px;
            font-weight: 700;
            letter-spacing: 2px;
            color: #2c7be5;
            color: #ff6a2f;
          "
        >
          ${code}
        </h2>
      </div>

      <p style="margin: 0 0 20px 0; font-size: 15px; color: #555">
        Enter this code in the verification page to complete the password reset
        process.
      </p>

      <p style="margin: 0; font-size: 14px; color: #777; line-height: 1.5">
        <strong>Note:</strong> This code will expire in 10 minutes. If you didn’t request this, please ignore this email or contact support.
      </p>
    </div>
  `;
};
