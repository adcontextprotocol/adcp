import { testAgent } from '@adcp/client/testing';

// Get all products to see their configuration
const result = await testAgent.getProducts({
  brief: 'show me all available products'
});

if (!result.success) {
  console.log('Error:', result.error);
  process.exit(1);
}

console.log(`Found ${result.data.products.length} products\n`);

for (const product of result.data.products) {
  console.log(`=== ${product.product_id} ===`);
  console.log(`  Name: ${product.name}`);
  console.log(`  Pricing options:`);
  for (const opt of product.pricing_options || []) {
    console.log(`    - ${opt.pricing_option_id}: ${opt.price} ${opt.pricing_model}`);
  }
  console.log(`  Format IDs: ${JSON.stringify(product.format_ids?.map(f => f.id))}`);
  console.log('');
}
