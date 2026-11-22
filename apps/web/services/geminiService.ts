
import { GoogleGenAI, Type } from "@google/genai";
import { AWSAccount } from "../types";

export const getAIRecommendations = async (accounts: AWSAccount[]): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const accountsSummary = accounts.map(acc => {
    return `Account: ${acc.name} (${acc.id}) has ASGs: ` + 
      acc.asgs.map(asg => `${asg.name} with ${JSON.stringify(asg.metrics)}`).join("; ");
  }).join("\n");

  const prompt = `
    You are the Amazon Bedrock Cloud Intelligence Architect. Your goal is to provide deep, high-value technical insights for the "Cloud-Ops" multi-account platform.
    
    Data Source: Centralized AWS Lambda (Master Account)
    Scope: ${accounts.length} Child Accounts
    
    Fleet Metrics:
    ${accountsSummary}

    Task:
    Perform a high-reasoning analysis of the Spot vs On-Demand ratio. Provide 3 high-impact architectural recommendations that leverage Bedrock-style thinking:
    
    - Look for cross-account consolidation opportunities.
    - Identify instance type families that are underutilized but have better spot availability.
    - Suggest specific 'Lifecycle' transitions.

    Format your response with the following bold sections:
    1. **Bedrock Fleet Insight Summary**: A high-level view of multi-account posture.
    2. **Architectural Recommendations**: (Provide 3 detailed bullets with estimated monthly ROI).
    3. **Spot Interruption Risk Analysis**: A calculated risk assessment based on instance family diversity.
  `;

  try {
    const response = await ai.models.generateContent({
      // Using Pro model for "Bedrock-level" reasoning as per coding guidelines
      model: 'gemini-3-pro-preview',
      contents: prompt,
    });
    return response.text || "Bedrock inference returned an empty response. Please check Lambda connectivity.";
  } catch (error) {
    console.error("Bedrock Simulation Error:", error);
    return "Error invoking Amazon Bedrock Intelligence layer. Ensure your AWS credentials/API Key are valid.";
  }
};
