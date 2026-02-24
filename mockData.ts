
import { AWSAccount, HistoricalData } from './types';

export const MOCK_ACCOUNTS: AWSAccount[] = [
  {
    id: "112233445566",
    name: "Production-Core",
    asgs: [
      {
        id: "asg-1",
        name: "web-app-production",
        region: "us-east-1",
        metrics: [
          { type: "t3.large", lifecycle: "on-demand", count: 4 },
          { type: "t3.large", lifecycle: "spot", count: 12 }
        ]
      },
      {
        id: "asg-2",
        name: "api-service-prod",
        region: "us-east-1",
        metrics: [
          { type: "m5.xlarge", lifecycle: "on-demand", count: 2 },
          { type: "m5.xlarge", lifecycle: "spot", count: 8 }
        ]
      }
    ]
  },
  {
    id: "998877665544",
    name: "Staging-Development",
    asgs: [
      {
        id: "asg-3",
        name: "dev-playground",
        region: "eu-west-1",
        metrics: [
          { type: "t2.micro", lifecycle: "spot", count: 15 }
        ]
      }
    ]
  },
  {
    id: "445566778899",
    name: "Shared-Services",
    asgs: [
      {
        id: "asg-4",
        name: "jenkins-nodes",
        region: "us-west-2",
        metrics: [
          { type: "c5.2xlarge", lifecycle: "on-demand", count: 3 },
          { type: "c5.2xlarge", lifecycle: "spot", count: 5 }
        ]
      }
    ]
  }
];

export const generateLast24Hours = (): HistoricalData[] => {
  const data: HistoricalData[] = [];
  const now = new Date();
  for (let i = 24; i >= 0; i--) {
    const time = new Date(now.getTime() - i * 3600000);
    data.push({
      timestamp: time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      spot: Math.floor(Math.random() * 20) + 30,
      onDemand: Math.floor(Math.random() * 10) + 10,
    });
  }
  return data;
};

export const generateLast7Days = (): HistoricalData[] => {
  const data: HistoricalData[] = [];
  const now = new Date();
  for (let i = 7; i >= 0; i--) {
    const date = new Date(now.getTime() - i * 86400000);
    data.push({
      timestamp: date.toLocaleDateString([], { month: 'short', day: 'numeric' }),
      spot: Math.floor(Math.random() * 50) + 200,
      onDemand: Math.floor(Math.random() * 30) + 80,
    });
  }
  return data;
};
