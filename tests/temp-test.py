import asyncio
from datetime import datetime, timedelta, timezone
from adcp import test_agent

async def create_campaign():
    # Calculate dates dynamically - start tomorrow, end in 90 days
    tomorrow = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    end_date = tomorrow + timedelta(days=90)

    print(f"Start time: {tomorrow.isoformat().replace('+00:00', 'Z')}")
    print(f"End time: {end_date.isoformat().replace('+00:00', 'Z')}")

    result = await test_agent.simple.create_media_buy(
        buyer_ref='summer_campaign_2025',
        brand_manifest={
            'name': 'Nike',
            'url': 'https://nike.com'
        },
        packages=[
            {
                'buyer_ref': 'ctv_package',
                'product_id': 'prod_d979b543',
                'pricing_option_id': 'cpm_usd_auction',
                'format_ids': [
                    {
                        'agent_url': 'https://creative.adcontextprotocol.org',
                        'id': 'display_300x250_image'
                    }
                ],
                'budget': 30000,
                'bid_price': 5.00
            },
            {
                'buyer_ref': 'audio_package',
                'product_id': 'prod_e8fd6012',
                'pricing_option_id': 'cpm_usd_auction',
                'format_ids': [
                    {
                        'agent_url': 'https://creative.adcontextprotocol.org',
                        'id': 'display_300x250_html'
                    }
                ],
                'budget': 20000,
                'bid_price': 4.50
            }
        ],
        start_time=tomorrow.isoformat().replace('+00:00', 'Z'),
        end_time=end_date.isoformat().replace('+00:00', 'Z')
    )

    # Check for errors (discriminated union response)
    if hasattr(result, 'errors') and result.errors:
        print(f"ERROR: Failed to create media buy: {result.errors}")
        return

    print(f"SUCCESS: Created media buy {result.media_buy_id}")
    print(f"Upload creatives by: {result.creative_deadline}")
    print(f"Packages created: {len(result.packages)}")

asyncio.run(create_campaign())
