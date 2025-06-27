import express, { Request, Response, NextFunction } from 'express';
import braintree from 'braintree';
import { Client, Databases } from 'node-appwrite';
import 'dotenv/config';

const app = express();
app.use(express.json());

// CORS Middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

const environment = process.env.BRAINTREE_ENVIRONMENT === 'Production'
  ? braintree.Environment.Production
  : braintree.Environment.Sandbox;

const gateway = new braintree.BraintreeGateway({
  environment,
  merchantId: process.env.BRAINTREE_MERCHANT_ID!,
  publicKey: process.env.BRAINTREE_PUBLIC_KEY!,
  privateKey: process.env.BRAINTREE_PRIVATE_KEY!
});

async function retryAsync<T>(fn: () => Promise<T>, retries: number, delay = 1000): Promise<T> {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

app.get('/ping', (req: Request, res: Response) => {
  res.json({ ok: true, message: 'pong' });
});

app.get('/client_token', async (req: Request, res: Response) => {
  try {
    //const response = await retryAsync<braintree.ClientTokenResponse>(() => gateway.clientToken.generate({}), 3);
    const response = await retryAsync(() => gateway.clientToken.generate({}), 3);
    res.json({ ok: true, clientToken: response.clientToken });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: 'Error generating client token', error: err.message });
  }
});

app.post('/checkout', async (req: Request, res: Response): Promise<void> => {
  const { name, email, phone, shippingAddress, billingAddress, orderDetails, payment_method_nonce, amount, deviceData } = req.body;

  if (!name || !email || !shippingAddress || !orderDetails || !payment_method_nonce || !amount) {
    res.status(400).json({ ok: false, message: 'Missing required fields' });
    return;
  }

  try {
    const result = await gateway.transaction.sale({
      amount: amount,
      paymentMethodNonce: payment_method_nonce,
      deviceData: deviceData,
      options: {
        submitForSettlement: true
      }
    });


    if (result.success) {
      const orderId = generateOrderId();
      const order = {
        name,
        email,
        phone,
        shippingAddress,
        billingAddress,
        orderId,
        orderDetails,
        creationTime: new Date().toISOString(),
        status: 'Pending',
        transactionId: result.transaction?.id
      };

      // Save order to Appwrite
      try {
        const client = new Client();
        client
          .setEndpoint(process.env.APPWRITE_ENDPOINT!)
          .setProject(process.env.APPWRITE_PROJECT!)
          .setKey(process.env.APPWRITE_API_KEY!);

        const database = new Databases(client);
        await retryAsync(() => database.createDocument(
          process.env.APPWRITE_DATABASE_ID!,
          process.env.APPWRITE_ORDERS_COLLECTION_ID!,
          orderId,
          order
        ), 3);

        res.json({ ok: true, orderId, transactionId: result.transaction?.id });
      } catch (dbError: any) {
        res.status(500).json({
          ok: false,
          message: 'Payment processed but order creation failed. Please contact support.',
          transactionId: result.transaction?.id
        });
      }
    } else {
      const status = result.transaction.status;
      res.status(400).json({ ok: false, message: status });
      return;
    }
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

function generateOrderId() {
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).slice(2, 7);
  return `${timestamp}-${randomStr}`.toUpperCase();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
