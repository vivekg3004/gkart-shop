/**
 * Gkart Shiprocket Integration Script
 * Handles order fulfillment, token generation, and shipment tracking.
 */

const SHIPROCKET_CONFIG = {
  baseUrl: 'https://apiv2.shiprocket.in/v1/external',
  email: window.SHIPROCKET_EMAIL || '', // Loaded from your config/environment
  password: window.SHIPROCKET_PASSWORD || ''
};

// Function to authenticate with Shiprocket and get token
async function getShiprocketToken() {
  try {
    const response = await fetch(`${SHIPROCKET_CONFIG.baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: SHIPROCKET_CONFIG.email,
        password: SHIPROCKET_CONFIG.password
      })
    });

    const data = await response.json();
    if (response.ok && data.token) {
      return data.token;
    } else {
      throw new Error(data.message || 'Failed to authenticate with Shiprocket');
    }
  } catch (error) {
    console.error('Shiprocket Auth Error:', error);
    return null;
  }
}

// Function to create an order in Shiprocket
async function createShiprocketOrder(orderData) {
  const token = await getShiprocketToken();
  if (!token) return { success: false, error: 'Authentication failed' };

  try {
    const response = await fetch(`${SHIPROCKET_CONFIG.baseUrl}/orders/create/adhoc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(orderData)
    });

    const result = await response.json();
    return { success: true, data: result };
  } catch (error) {
    console.error('Create Order Error:', error);
    return { success: false, error: error.message };
  }
}

window.ShiprocketService = {
  getShiprocketToken,
  createShiprocketOrder
};
