// src/mockData.ts

// ---- LIVE MOCK ----
export const mockLiveData = {
  status: "success",
  data: [
    {
      accountId: "351387070227",
      region: "ap-south-1",
      spotCount: 5,
      onDemandCount: 8,
      asgs: [
        {
          asgName: "web-asg",
          instanceType: "t3.medium",
          spot: 3,
          onDemand: 2
        },
        {
          asgName: "worker-asg",
          instanceType: "m5.large",
          spot: 2,
          onDemand: 6
        }
      ],
      timestamp: Math.floor(Date.now() / 1000)
    }
  ]
};

// ---- SUMMARY MOCK ----
export const mockSummaryData = {
  status: "success",
  totalSpot: 12,
  totalOnDemand: 20,
  accounts: [
    {
      accountId: "351387070227",
      totalSpot: 5,
      totalOnDemand: 8
    }
  ]
};

// ---- HISTORY MOCK ----
export const mockHistoryData = {
  status: "success",
  data: [
    {
      accountId: "351387070227",
      region: "ap-south-1",
      date: "2026-01-22",
      hour: "10",
      spotCount: 4,
      onDemandCount: 7
    },
    {
      accountId: "351387070227",
      region: "ap-south-1",
      date: "2026-01-22",
      hour: "11",
      spotCount: 5,
      onDemandCount: 8
    },
    {
      accountId: "351387070227",
      region: "ap-south-1",
      date: "2026-01-22",
      hour: "12",
      spotCount: 6,
      onDemandCount: 9
    }
  ]
};
