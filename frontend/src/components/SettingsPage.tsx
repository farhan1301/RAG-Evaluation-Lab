import { Save, Key, User, Bell, Database } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';

interface SettingsPageProps {
  darkMode: boolean;
}

export function SettingsPage({ darkMode }: SettingsPageProps) {
  return (
    <div className={`p-8 ${darkMode ? 'bg-zinc-900' : 'bg-zinc-50'}`}>
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h2 className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Settings</h2>
          <p className={`${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
            Manage your account and application preferences
          </p>
        </div>

        {/* Profile Settings */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <User size={20} />
              <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Profile</CardTitle>
            </div>
            <CardDescription className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
              Update your profile information
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstName" className={darkMode ? 'text-zinc-300' : 'text-zinc-700'}>
                  First Name
                </Label>
                <Input id="firstName" placeholder="John" defaultValue="John" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName" className={darkMode ? 'text-zinc-300' : 'text-zinc-700'}>
                  Last Name
                </Label>
                <Input id="lastName" placeholder="Doe" defaultValue="Doe" />
              </div>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="email" className={darkMode ? 'text-zinc-300' : 'text-zinc-700'}>
                Email
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="john.doe@example.com"
                defaultValue="john.doe@example.com"
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="organization" className={darkMode ? 'text-zinc-300' : 'text-zinc-700'}>
                Organization
              </Label>
              <Input id="organization" placeholder="Acme Inc." defaultValue="Acme Inc." />
            </div>
            
            <Button className="gap-2">
              <Save size={16} />
              Save Profile
            </Button>
          </CardContent>
        </Card>

        {/* Security Settings */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Key size={20} />
              <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Security</CardTitle>
            </div>
            <CardDescription className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
              Manage your password and security settings
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="currentPassword" className={darkMode ? 'text-zinc-300' : 'text-zinc-700'}>
                Current Password
              </Label>
              <Input id="currentPassword" type="password" placeholder="••••••••" />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="newPassword" className={darkMode ? 'text-zinc-300' : 'text-zinc-700'}>
                New Password
              </Label>
              <Input id="newPassword" type="password" placeholder="••••••••" />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="confirmPassword" className={darkMode ? 'text-zinc-300' : 'text-zinc-700'}>
                Confirm New Password
              </Label>
              <Input id="confirmPassword" type="password" placeholder="••••••••" />
            </div>
            
            <Button className="gap-2">
              <Save size={16} />
              Change Password
            </Button>
          </CardContent>
        </Card>

        {/* API Keys */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Key size={20} />
              <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>API Keys</CardTitle>
            </div>
            <CardDescription className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
              Manage API keys for external services (OpenAI, Cohere, etc.)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="openaiKey" className={darkMode ? 'text-zinc-300' : 'text-zinc-700'}>
                OpenAI API Key
              </Label>
              <Input
                id="openaiKey"
                type="password"
                placeholder="sk-..."
                defaultValue="sk-proj-..."
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="cohereKey" className={darkMode ? 'text-zinc-300' : 'text-zinc-700'}>
                Cohere API Key
              </Label>
              <Input id="cohereKey" type="password" placeholder="..." />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="anthropicKey" className={darkMode ? 'text-zinc-300' : 'text-zinc-700'}>
                Anthropic API Key
              </Label>
              <Input id="anthropicKey" type="password" placeholder="sk-ant-..." />
            </div>
            
            <Button className="gap-2">
              <Save size={16} />
              Save API Keys
            </Button>
          </CardContent>
        </Card>

        {/* Data & Privacy */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Database size={20} />
              <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Data & Privacy</CardTitle>
            </div>
            <CardDescription className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
              Control how your data is stored and used
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex-1 pr-4">
                <Label className={`${darkMode ? 'text-zinc-300' : 'text-zinc-700'} block mb-1`}>
                  Auto-delete experiments after 30 days
                </Label>
                <p className={`text-sm ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  Automatically remove experiment data older than 30 days
                </p>
              </div>
              <Switch />
            </div>
            
            <Separator className={darkMode ? 'bg-zinc-700' : ''} />
            
            <div className="flex items-center justify-between">
              <div className="flex-1 pr-4">
                <Label className={`${darkMode ? 'text-zinc-300' : 'text-zinc-700'} block mb-1`}>
                  Store uploaded documents
                </Label>
                <p className={`text-sm ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  Keep uploaded documents for future experiments
                </p>
              </div>
              <Switch defaultChecked />
            </div>
            
            <Separator className={darkMode ? 'bg-zinc-700' : ''} />
            
            <div className="flex items-center justify-between">
              <div className="flex-1 pr-4">
                <Label className={`${darkMode ? 'text-zinc-300' : 'text-zinc-700'} block mb-1`}>
                  Share anonymous usage data
                </Label>
                <p className={`text-sm ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  Help improve the platform by sharing anonymous metrics
                </p>
              </div>
              <Switch />
            </div>
          </CardContent>
        </Card>

        {/* Notifications */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Bell size={20} />
              <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Notifications</CardTitle>
            </div>
            <CardDescription className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
              Manage your notification preferences
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex-1 pr-4">
                <Label className={`${darkMode ? 'text-zinc-300' : 'text-zinc-700'} block mb-1`}>
                  Experiment completion emails
                </Label>
                <p className={`text-sm ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  Get notified when experiments finish running
                </p>
              </div>
              <Switch defaultChecked />
            </div>
            
            <Separator className={darkMode ? 'bg-zinc-700' : ''} />
            
            <div className="flex items-center justify-between">
              <div className="flex-1 pr-4">
                <Label className={`${darkMode ? 'text-zinc-300' : 'text-zinc-700'} block mb-1`}>
                  Weekly summary reports
                </Label>
                <p className={`text-sm ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  Receive weekly summaries of your experiments
                </p>
              </div>
              <Switch />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
