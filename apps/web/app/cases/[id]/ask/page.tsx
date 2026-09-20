import { AskWorkspace } from '@/components/ask-lloyd/AskWorkspace';
export default async function AskPage({params}:{params:Promise<{id:string}>}){const {id}=await params;return <AskWorkspace caseId={decodeURIComponent(id)}/>;}
