import fetch from 'node-fetch';

const handler = async (req, res) => {
  // Enable CORS for frontend requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { action, campaignId } = req.query;
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
  const businessAccountId = process.env.BUSINESS_ACCOUNT_ID;

  // Validate environment variables
  if (!accessToken || !businessAccountId) {
    console.error('Missing environment variables');
    return res.status(400).json({
      error: 'Missing environment variables',
      message: 'FACEBOOK_ACCESS_TOKEN and BUSINESS_ACCOUNT_ID are required',
      troubleshooting: 'Please set these in Vercel project settings'
    });
  }

  try {
    if (action === 'getCampaigns') {
      return await getCampaigns(res, accessToken, businessAccountId);
    } else if (action === 'getInsights' && campaignId) {
      return await getInsights(res, accessToken, campaignId);
    } else {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Please provide action=getCampaigns or action=getInsights with campaignId'
      });
    }
  } catch (error) {
    console.error('API Error:', error.message);
    return res.status(500).json({
      error: 'API Error',
      message: error.message,
      troubleshooting: 'Check access token and business account ID permissions'
    });
  }
};

/**
 * Fetch all ad accounts under a Business Manager
 * @param {string} accessToken - Facebook access token
 * @param {string} businessAccountId - Business Manager ID
 * @returns {Promise<Array>} Array of ad accounts
 */
const getAdAccounts = async (accessToken, businessAccountId) => {
  try {
    const url = `https://graph.facebook.com/v18.0/${businessAccountId}/adaccounts?fields=id,name,currency&limit=100&access_token=${accessToken}`;

    console.log(`Fetching ad accounts for Business Manager: ${businessAccountId}`);
    const response = await fetch(url);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
            console.error('URL:', url);
            console.error('Full Error Response:', JSON.stringify(errorData));
      console.error(`Facebook API Error: ${response.status}`, errorData);
      throw new Error(`Facebook API Error: ${response.status} - ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();

    if (!data.data || data.data.length === 0) {
      console.warn('No ad accounts found for this Business Manager');
      return [];
    }

    console.log(`Found ${data.data.length} ad accounts`);
    return data.data;
  } catch (error) {
    console.error('Error fetching ad accounts:', error.message);
    throw error;
  }
};

/**
 * Fetch campaigns from a single ad account
 * @param {string} accessToken - Facebook access token
 * @param {string} adAccountId - Ad Account ID (without act_ prefix)
 * @returns {Promise<Array>} Array of campaigns
 */
const getCampaignsForAccount = async (accessToken, adAccountId) => {
  try {
    const url = `https://graph.facebook.com/v18.0/act_${adAccountId}/campaigns?fields=id,name,status,objective&limit=100&access_token=${accessToken}`;

    const response = await fetch(url);

    if (!response.ok) {
      console.warn(`Failed to fetch campaigns for account act_${adAccountId}: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error(`Error fetching campaigns for account ${adAccountId}:`, error.message);
    return [];
  }
};

/**
 * Fetch insights for a single campaign
 * @param {string} accessToken - Facebook access token
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<Object>} Campaign insights data
 */
const getCampaignInsights = async (accessToken, campaignId) => {
  try {
    const url = `https://graph.facebook.com/v18.0/${campaignId}/insights?fields=impressions,clicks,spend,ctr,cpc,cpm&access_token=${accessToken}`;

    const response = await fetch(url);

    if (!response.ok) {
      return {};
    }

    const data = await response.json();
    return data.data?.[0] || {};
  } catch (error) {
    console.error(`Error fetching insights for campaign ${campaignId}:`, error.message);
    return {};
  }
};

/**
 * Main function to fetch all campaigns from all ad accounts
 * Aggregates data from multiple accounts
 */
const getCampaigns = async (res, accessToken, businessAccountId) => {
  try {
    // Step 1: Get all ad accounts under the business manager
    const adAccounts = await getAdAccounts(accessToken, businessAccountId);

    // Handle case with no ad accounts
    if (adAccounts.length === 0) {
      console.warn('No ad accounts found');
      return res.status(200).json({
        campaigns: [],
        metrics: {
          totalImpressions: 0,
          totalClicks: 0,
          totalSpend: 0,
          totalCampaigns: 0,
          avgCpc: 0,
          avgCpm: 0,
          roas: 0
        },
        accountSummaries: [],
        adAccountsCount: 0
      });
    }

    // Step 2: Fetch campaigns from all ad accounts
    const allCampaigns = [];
    const accountSummaries = [];

    for (const account of adAccounts) {
      try {
        // Remove 'act_' prefix if it exists
        const adAccountId = account.id.replace('act_', '');
        console.log(`Processing account: ${account.name} (${account.id})`);

        // Get campaigns for this account
        const campaigns = await getCampaignsForAccount(accessToken, adAccountId);

        if (campaigns.length === 0) {
          console.log(`No campaigns in account ${account.name}`);
          accountSummaries.push({
            accountId: account.id,
            accountName: account.name,
            totalImpressions: 0,
            totalClicks: 0,
            totalSpend: 0,
            totalCampaigns: 0,
            avgCpc: 0,
            avgCpm: 0
          });
          continue;
        }

        // Fetch insights for each campaign
        const campaignsWithInsights = await Promise.all(
          campaigns.map(async (campaign) => {
            try {
              const insights = await getCampaignInsights(accessToken, campaign.id);

              return {
                id: campaign.id,
                name: campaign.name,
                status: campaign.status,
                objective: campaign.objective,
                accountId: account.id,
                accountName: account.name,
                impressions: parseInt(insights.impressions || 0),
                clicks: parseInt(insights.clicks || 0),
                spend: parseFloat(insights.spend || 0),
                ctr: parseFloat(insights.ctr || 0),
                cpc: parseFloat(insights.cpc || 0),
                cpm: parseFloat(insights.cpm || 0)
              };
            } catch (error) {
              console.error(`Error processing campaign ${campaign.id}:`, error.message);
              return {
                id: campaign.id,
                name: campaign.name,
                status: campaign.status,
                objective: campaign.objective,
                accountId: account.id,
                accountName: account.name,
                impressions: 0,
                clicks: 0,
                spend: 0,
                ctr: 0,
                cpc: 0,
                cpm: 0
              };
            }
          })
        );

        allCampaigns.push(...campaignsWithInsights);

        // Calculate metrics for this account
        const accountMetrics = campaignsWithInsights.reduce(
          (acc, campaign) => ({
            totalImpressions: acc.totalImpressions + (campaign.impressions || 0),
            totalClicks: acc.totalClicks + (campaign.clicks || 0),
            totalSpend: acc.totalSpend + (campaign.spend || 0),
            totalCampaigns: acc.totalCampaigns + 1
          }),
          { totalImpressions: 0, totalClicks: 0, totalSpend: 0, totalCampaigns: 0 }
        );

        accountSummaries.push({
          accountId: account.id,
          accountName: account.name,
          ...accountMetrics,
          avgCpc: accountMetrics.totalClicks > 0 ? (accountMetrics.totalSpend / accountMetrics.totalClicks).toFixed(2) : 0,
          avgCpm: accountMetrics.totalImpressions > 0 ? ((accountMetrics.totalSpend / accountMetrics.totalImpressions) * 1000).toFixed(2) : 0
        });
      } catch (error) {
        console.error(`Error processing account ${account.name}:`, error.message);
        continue;
      }
    }

    // Step 3: Calculate total aggregated metrics
    const totalMetrics = allCampaigns.reduce(
      (acc, campaign) => ({
        totalImpressions: acc.totalImpressions + (campaign.impressions || 0),
        totalClicks: acc.totalClicks + (campaign.clicks || 0),
        totalSpend: acc.totalSpend + (campaign.spend || 0),
        totalCampaigns: acc.totalCampaigns + 1
      }),
      { totalImpressions: 0, totalClicks: 0, totalSpend: 0, totalCampaigns: 0 }
    );

    console.log(`Total campaigns fetched: ${allCampaigns.length}`);

    return res.status(200).json({
      campaigns: allCampaigns,
      metrics: {
        ...totalMetrics,
        avgCpc: totalMetrics.totalClicks > 0 ? (totalMetrics.totalSpend / totalMetrics.totalClicks).toFixed(2) : 0,
        avgCpm: totalMetrics.totalImpressions > 0 ? ((totalMetrics.totalSpend / totalMetrics.totalImpressions) * 1000).toFixed(2) : 0,
        roas: 0
      },
      accountSummaries: accountSummaries,
      adAccountsCount: adAccounts.length
    });
  } catch (error) {
    console.error('Error in getCampaigns:', error.message);
    return res.status(500).json({
      error: 'Failed to fetch campaigns',
      message: error.message,
      troubleshooting: 'Ensure BUSINESS_ACCOUNT_ID has access to ad accounts and access token is valid'
    });
  }
};

/**
 * Fetch detailed insights for a specific campaign
 */
const getInsights = async (res, accessToken, campaignId) => {
  try {
    const url = `https://graph.facebook.com/v18.0/${campaignId}/insights?fields=impressions,clicks,spend,ctr,cpc,cpm,frequency,reach,actions,action_values&access_token=${accessToken}`;

    console.log(`Fetching detailed insights for campaign: ${campaignId}`);
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Facebook API Error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const insights = data.data?.[0] || {};

    return res.status(200).json({
      campaignId,
      insights: {
        impressions: parseInt(insights.impressions || 0),
        clicks: parseInt(insights.clicks || 0),
        spend: parseFloat(insights.spend || 0),
        ctr: parseFloat(insights.ctr || 0),
        cpc: parseFloat(insights.cpc || 0),
        cpm: parseFloat(insights.cpm || 0),
        frequency: parseFloat(insights.frequency || 0),
        reach: parseInt(insights.reach || 0),
        actions: insights.actions || [],
        actionValues: insights.action_values || []
      }
    });
  } catch (error) {
    console.error('Error fetching insights:', error.message);
    return res.status(500).json({
      error: 'Failed to fetch insights',
      message: error.message,
      troubleshooting: 'Check if campaign ID is valid and access token has required permissions'
    });
  }
};

export default handler;
