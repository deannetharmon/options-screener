// app/test-trade/page.tsx
'use client';

import { useState } from 'react';
import { 
  getCustomerAccounts, 
  placeOrder, 
  buildBullPutSpread   // We will add this function next
} from '@/lib/tastytrade';

export default function TestTradePage() {
  const [token, setToken] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [status, setStatus] = useState('');
  const [isSandbox, setIsSandbox] = useState(true);   // Start with sandbox = safe

  const handleGetAccounts = async () => {
    if (!token) {
      alert("Please paste your access token first");
      return;
    }

    setStatus("Getting accounts...");
    try {
      const accounts = await getCustomerAccounts(token, isSandbox);
      if (accounts.length > 0) {
        setAccountNumber(accounts[0].account_number);
        setStatus(`✅ Found account: ${accounts[0].account_number}`);
      } else {
        setStatus("No accounts found");
      }
    } catch (err: any) {
      setStatus("❌ Error: " + err.message);
    }
  };

  const handleTestOrder = async () => {
    if (!token || !accountNumber) {
      alert("Need token and account number first");
      return;
    }

    setStatus("Creating dry-run order...");

    // Example Bull Put Spread (this is fake data for testing)
    const orderPayload = {
      "time-in-force": "Day",
      "order-type": "Limit",
      "price": "1.25",                    // net credit you want to receive
      "legs": [
        {
          "symbol": "SPY  250516P00560000",   // example short put
          "quantity": 1,
          "action": "Sell to Open",
          "order-leg-type": "Equity Option"
        },
        {
          "symbol": "SPY  250516P00550000",   // example long put
          "quantity": 1,
          "action": "Buy to Open",
          "order-leg-type": "Equity Option"
        }
      ]
    };

    try {
      const result = await placeOrder(
        accountNumber,
        orderPayload,
        token,
        isSandbox,
        true   // dryRun = true (safe, no real trade)
      );

      setStatus(`✅ Dry-run successful! Order ID: ${result.data?.id || 'unknown'}`);
      console.log("Order result:", result);
    } catch (err: any) {
      setStatus("❌ Order failed: " + err.message);
    }
  };

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Test Trading (Safe Mode)</h1>

      <div className="space-y-6">
        <div>
          <label className="block text-sm mb-2">Access Token</label>
          <input
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full p-3 border rounded"
            placeholder="Paste your TastyTrade access token here"
          />
        </div>

        <div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isSandbox}
              onChange={(e) => setIsSandbox(e.target.checked)}
            />
            Use Sandbox (Fake Money) - Keep this ON for now
          </label>
        </div>

        <button
          onClick={handleGetAccounts}
          className="bg-blue-600 text-white px-6 py-3 rounded hover:bg-blue-700"
        >
          1. Get My Account Number
        </button>

        {accountNumber && (
          <p className="text-green-600 font-medium">Account: {accountNumber}</p>
        )}

        <button
          onClick={handleTestOrder}
          className="bg-green-600 text-white px-6 py-3 rounded hover:bg-green-700"
          disabled={!accountNumber}
        >
          2. Test Dry-Run Bull Put Spread
        </button>

        <div className="p-4 bg-gray-100 rounded min-h-[100px] whitespace-pre-wrap">
          {status || "Status will appear here..."}
        </div>
      </div>
    </div>
  );
}
