import React, { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import Dashboard from './components/Dashboard';
import EquipmentList from './components/EquipmentList';
import LicenseControl from './components/LicenseControl';
import UserManagement from './components/UserManagement';
import Settings from './components/Settings';
import AuditLog from './components/AuditLog';
import Login from './components/Login';
import TwoFactorAuth from './components/TwoFactorAuth';
import TwoFactorSetup from './components/TwoFactorSetup'; // Novo componente
import { Page, User, UserRole, AppSettings } from './types'; // Import AppSettings type
import { getSettings } from './services/apiService';
import AIAssistantWidget from './components/AIAssistantWidget';

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [userFor2FA, setUserFor2FA] = useState<User | null>(null);
  const [userFor2FASetup, setUserFor2FASetup] = useState<User | null>(null); // Novo estado
  const [activePage, setActivePage] = useState<Page>('Dashboard');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [companyName, setCompanyName] = useState('MRR INFORMATICA');
  const [isSsoEnabled, setIsSsoEnabled] = useState(false);
  const [globalSettings, setGlobalSettings] = useState<Partial<AppSettings>>({});

  // 1. Carrega usuário do localStorage
  useEffect(() => {
    const savedUser = localStorage.getItem('currentUser');
    if (savedUser) {
      const user = JSON.parse(savedUser);
      if (user.is2FAEnabled && !sessionStorage.getItem('2fa_verified')) {
        setUserFor2FA(user);
      } else {
        setCurrentUser(user);
      }
    }
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      document.documentElement.classList.add('dark');
      setIsDarkMode(true);
    }
  }, []);
  
  // 2. Busca configurações globais
  const fetchSettings = useCallback(async () => {
        try {
            const settings = await getSettings();
            setGlobalSettings(settings);
            setCompanyName(settings.companyName || 'MRR INFORMATICA');
            setIsSsoEnabled(settings.isSsoEnabled || false);
        } catch (error) {
            console.error("Failed to fetch settings:", error);
        }
    }, []);

    useEffect(() => {
        fetchSettings();
    }, [fetchSettings]);

    // 3. Validação de Segurança: Força setup de 2FA se obrigatório globalmente e não configurado pelo usuário (mesmo se já logado via localStorage)
    useEffect(() => {
        if (currentUser && globalSettings.require2fa && !currentUser.is2FAEnabled && !userFor2FASetup) {
            // Se o usuário já está logado (ex: localStorage), mas o 2FA é obrigatório e ele não tem
            // Forçamos o fluxo de setup
            setUserFor2FASetup(currentUser);
            setCurrentUser(null); // Remove da tela principal para não vazar dados
        }
    }, [currentUser, globalSettings.require2fa, userFor2FASetup]);


  const handleLoginSuccess = (user: User & { requires2FASetup?: boolean }) => {
    if (user.requires2FASetup) {
      setUserFor2FASetup(user);
    } else if (user.is2FAEnabled) {
      setUserFor2FA(user);
    } else {
      setCurrentUser(user);
      localStorage.setItem('currentUser', JSON.stringify(user));
    }
  };
  
  const handle2FAVerificationSuccess = (user: User) => {
    sessionStorage.setItem('2fa_verified', 'true');
    setCurrentUser(user);
    setUserFor2FA(null);
    localStorage.setItem('currentUser', JSON.stringify(user));
  };
  
  const handle2FASetupSuccess = (user: User) => {
    const updatedUser = { ...user, is2FAEnabled: true };
    sessionStorage.setItem('2fa_verified', 'true');
    setCurrentUser(updatedUser);
    setUserFor2FASetup(null);
    localStorage.setItem('currentUser', JSON.stringify(updatedUser));
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setUserFor2FA(null);
    setUserFor2FASetup(null); // Limpar estado
    localStorage.removeItem('currentUser');
    sessionStorage.removeItem('2fa_verified');
    setActivePage('Dashboard');
  };
  
  const handleUserUpdate = (updatedUser: User) => {
    setCurrentUser(updatedUser);
    localStorage.setItem('currentUser', JSON.stringify(updatedUser));
  };

  const toggleTheme = () => {
    setIsDarkMode(prev => {
      const newIsDark = !prev;
      if (newIsDark) {
        document.documentElement.classList.add('dark');
        localStorage.setItem('theme', 'dark');
      } else {
        document.documentElement.classList.remove('dark');
        localStorage.setItem('theme', 'light');
      }
      return newIsDark;
    });
  };

  const pages: Page[] = [
    'Dashboard',
    'Inventário de Equipamentos',
    'Controle de Licenças',
  ];

  if (currentUser && [UserRole.Admin, UserRole.UserManager].includes(currentUser.role)) {
    pages.push('Usuários e Permissões');
  }

  if (currentUser && currentUser.role === UserRole.Admin) {
    pages.push('Auditoria');
    pages.push('Configurações');
  }


  const renderPage = () => {
    if (!currentUser) return null;
    switch (activePage) {
      case 'Dashboard':
        return <Dashboard setActivePage={setActivePage} currentUser={currentUser} />;
      case 'Inventário de Equipamentos':
        return <EquipmentList currentUser={currentUser} companyName={companyName} />;
      case 'Controle de Licenças':
        return <LicenseControl currentUser={currentUser} />;
      case 'Usuários e Permissões':
        return <UserManagement currentUser={currentUser} />;
      case 'Auditoria':
        return <AuditLog />;
      case 'Configurações':
        return <Settings currentUser={currentUser} onUserUpdate={handleUserUpdate}/>;
      default:
        return <Dashboard setActivePage={setActivePage} currentUser={currentUser} />;
    }
  };

  if (userFor2FASetup) {
    return <TwoFactorSetup user={userFor2FASetup} onSetupSuccess={handle2FASetupSuccess} onCancel={handleLogout} />
  }

  if (userFor2FA) {
      return <TwoFactorAuth user={userFor2FA} onVerificationSuccess={handle2FAVerificationSuccess} onCancel={handleLogout} />
  }

  if (!currentUser) {
    return <Login onLoginSuccess={handleLoginSuccess} isSsoEnabled={isSsoEnabled} />;
  }

  return (
    <div className="flex h-screen bg-gray-100 dark:bg-dark-bg text-gray-800 dark:text-dark-text-primary">
      <Sidebar
        activePage={activePage}
        setActivePage={setActivePage}
        pages={pages}
        isSidebarOpen={isSidebarOpen}
        setIsSidebarOpen={setIsSidebarOpen}
      />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header
          pageTitle={activePage}
          user={currentUser}
          onLogout={handleLogout}
          toggleTheme={toggleTheme}
          isDarkMode={isDarkMode}
          setIsSidebarOpen={setIsSidebarOpen}
          onUserUpdate={handleUserUpdate}
        />
        <main className="flex-1 overflow-x-hidden overflow-y-auto bg-gray-100 dark:bg-dark-bg p-4 sm:p-6">
          {renderPage()}
        </main>
      </div>
      <AIAssistantWidget currentUser={currentUser} />
    </div>
  );
};

export default App;