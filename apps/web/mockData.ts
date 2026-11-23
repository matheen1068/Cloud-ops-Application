
// Sample trend data for the Analytics preview (real metrics come later).
import { HistoricalData } from './types';

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
