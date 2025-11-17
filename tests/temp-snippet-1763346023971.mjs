import { testAgent } from '@adcp/client/testing';

const result = await testAgent.getProducts({
  brief: 'Premium athletic footwear with innovative cushioning',
  brand_manifest: {
    name: 'Nike',
    url: 'https://nike.com'
  }
});

if (result.success && result.data) {
  console.log(`Found ${result.data.products.length} products`);
}