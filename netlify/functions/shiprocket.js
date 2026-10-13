// Hidden Backend Server: netlify/functions/shiprocket.js
// Handles: 1) Razorpay Order & Verification, 2) Shiprocket Dispatch & Cancellation, 3) Live Shiprocket Webhooks
const crypto = require("crypto");

const SUPABASE_URL = "https://fwzjswlkfwepgfqvapkm.supabase.co";
const SUPABASE_KEY = "sb_publishable_JhilDbcHlGIoj5Hvae3wmw_u2HHPeaQ";

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    // ====================================================================
    // 1. INCOMING SHIPROCKET WEBHOOK LISTENER (AUTO-UPDATES SUPABASE)
    // ====================================================================
    if (!body.action && (body.current_status || body.shipment_status)) {
      const rawStatus = (body.current_status || body.shipment_status || "").toUpperCase();
      const srOrderId = String(body.order_id || "");

      let mappedStage = "Confirmed";
      if (rawStatus.includes("PICKED") || rawStatus.includes("PACKED") || rawStatus.includes("MANIFEST")) {
        mappedStage = "Packed";
      } else if (rawStatus.includes("TRANSIT") || rawStatus.includes("SHIPPED") || rawStatus.includes("OUT FOR DELIVERY")) {
        mappedStage = "Shipped";
      } else if (rawStatus.includes("DELIVERED")) {
        mappedStage = "Delivered";
      } else if (rawStatus.includes("CANCEL") || rawStatus.includes("RTO")) {
        mappedStage = "Cancelled";
      }

      // Extract numeric Supabase order ID if formatted as GKART-<id>
      if (srOrderId.startsWith("GKART-")) {
        const dbOrderId = srOrderId.replace("GKART-", "").split("-")[0];
        if (!isNaN(dbOrderId)) {
          await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${dbOrderId}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`
            },
            body: JSON.stringify({
              lifecycle_stage: mappedStage,
              order_status: `Courier Status: ${rawStatus} (AWB: ${body.awb || "Assigned"})`
            })
          });
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ received: true, updated_stage: mappedStage })
      };
    }

    // ====================================================================
    // 2. CREATE RAZORPAY ORDER (FOR ONLINE PAYMENT)
    // ====================================================================
    if (body.action === "create_razorpay_order") {
      const rzpKeyId = process.env.RAZORPAY_KEY_ID;
      const rzpKeySecret = process.env.RAZORPAY_KEY_SECRET;

      if (!rzpKeyId || !rzpKeySecret) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Razorpay keys missing in Netlify Environment Variables."
          })
        };
      }

      const authHeader = "Basic " + Buffer.from(`${rzpKeyId}:${rzpKeySecret}`).toString("base64");
      const amountInPaise = Math.round(Number(body.amount) * 100);

      const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader
        },
        body: JSON.stringify({
          amount: amountInPaise,
          currency: "INR",
          receipt: "GKART_RCPT_" + Date.now()
        })
      });

      const rzpOrder = await rzpRes.json();
      if (!rzpOrder.id) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Failed to create Razorpay order", details: rzpOrder })
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          key_id: rzpKeyId,
          order_id: rzpOrder.id,
          amount: rzpOrder.amount
        })
      };
    }

    // ====================================================================
    // 3. SHIPROCKET AUTHENTICATION
    // ====================================================================
    const email = process.env.SHIPROCKET_EMAIL;
    const password = process.env.SHIPROCKET_PASSWORD;

    if (!email || !password) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Shiprocket credentials not configured in environment variables." })
      };
    }

    const authRes = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const authData = await authRes.json();

    if (!authData.token) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Shiprocket API login failed", details: authData })
      };
    }

    const token = authData.token;

    // ====================================================================
    // 4. CHECK PINCODE SERVICEABILITY
    // ====================================================================
    if (body.action === "check_pincode") {
      const pickupPin = body.pickup_pincode || "411035";
      const deliveryPin = body.delivery_pincode;
      const url = `https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=${pickupPin}&delivery_postcode=${deliveryPin}&weight=0.5&cod=1`;

      const pinRes = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const pinData = await pinRes.json();

      const couriers = pinData?.data?.available_courier_companies || [];
      if (couriers.length > 0) {
        const fastest = couriers[0];
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            serviceable: true,
            courier_name: fastest.courier_name,
            etd: fastest.etd || "3-5 Days",
            rate: fastest.rate
          })
        };
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ serviceable: false })
      };
    }

    // ====================================================================
    // 5. CREATE SHIPROCKET ORDER
    // ====================================================================
    if (body.action === "create_order") {
      if (body.payment_method === "Prepaid" && body.razorpay_payment_id) {
        const rzpSecret = process.env.RAZORPAY_KEY_SECRET;
        const expectedSignature = crypto
          .createHmac("sha256", rzpSecret)
          .update(body.razorpay_order_id + "|" + body.razorpay_payment_id)
          .digest("hex");

        if (expectedSignature !== body.razorpay_signature) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: "Invalid Razorpay payment signature! Order rejected." })
          };
        }
      }

      let pickupLocation = "Primary";
      try {
        const locRes = await fetch("https://apiv2.shiprocket.in/v1/external/settings/company/pickup", {
          headers: { Authorization: `Bearer ${token}` }
        });
        const locData = await locRes.json();
        const addresses = locData?.data?.shipping_address || [];
        if (addresses.length > 0 && addresses[0].pickup_location) {
          pickupLocation = addresses[0].pickup_location;
        }
      } catch (e) {}

      const customOrderRef = body.db_order_id ? `GKART-${body.db_order_id}` : `GKART-${Date.now()}`;

      const orderPayload = {
        order_id: customOrderRef,
        order_date: new Date().toISOString().split("T")[0],
        pickup_location: pickupLocation,
        billing_customer_name: body.customer_name,
        billing_last_name: "",
        billing_address: body.shipping_address,
        billing_city: body.city || "Pune",
        billing_pincode: body.pincode,
        billing_state: body.state || "Maharashtra",
        billing_country: "India",
        billing_email: body.customer_email || "gvivek3004@gmail.com",
        billing_phone: body.customer_phone,
        shipping_is_billing: true,
        order_items: body.items.map((item, idx) => ({
          name: item.name,
          sku: item.sku || `GKART-SKU-${item.id || idx + 1}`,
          units: item.qty || 1,
          selling_price: item.price
        })),
        payment_method: body.payment_method === "COD" ? "COD" : "Prepaid",
        sub_total: body.total_amount,
        length: 12,
        breadth: 12,
        height: 10,
        weight: 0.5
      };

      const orderRes = await fetch("https://apiv2.shiprocket.in/v1/external/orders/create/adhoc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(orderPayload)
      });

      const orderData = await orderRes.json();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(orderData)
      };
    }

    // ====================================================================
    // 6. CANCEL SHIPROCKET ORDER WHEN CUSTOMER CANCELS ON WEBSITE
    // ====================================================================
    if (body.action === "cancel_order" && body.shiprocket_order_id) {
      const cancelRes = await fetch("https://apiv2.shiprocket.in/v1/external/orders/cancel", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ ids: [Number(body.shiprocket_order_id)] })
      });
      const cancelData = await cancelRes.json();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(cancelData)
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid action" })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
