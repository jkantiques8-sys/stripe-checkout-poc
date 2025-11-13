// /netlify/functions/send-confirmation.js
import fetch from "node-fetch";

export const handler = async (event) => {
  try {
    const { email, name, orderTotal, deliveryDate } = JSON.parse(event.body);

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "Kraus Tables & Chairs <orders@kraustables.com>",
        to: [email],
        subject: "Order Received – Kraus Tables & Chairs",
        html: `
          <div style="font-family: Arial, sans-serif; color: #333;">
            <h2>Thank you, ${name}!</h2>
            <p>We've received your order totaling <strong>$${orderTotal}</strong>.</p>
            <p>We’ll review your delivery details and contact you within 24 hours to confirm your order and delivery time.</p>
            ${
              deliveryDate
                ? `<p><strong>Requested delivery date:</strong> ${deliveryDate}</p>`
                : ""
            }
            <p>If you have any questions, just reply to this email or call us at (718) 218-4057.</p>
            <p style="margin-top: 20px;">— The Kraus Tables & Chairs Team</p>
          </div>
        `
      })
    });

    if (!response.ok) throw new Error(`Resend error: ${response.statusText}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: "Email sent!" })
    };
  } catch (err) {
    console.error("Error sending email:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
