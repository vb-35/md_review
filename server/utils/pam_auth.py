from config import Config

def authenticate(username, password):
    if Config.LOCAL_AUTH == 'on':
        if username and password:
            return {"success": True}
        return {"success": False, "error": "Credentials required"}
    try:
        import pam
        return {"success": pam.authenticate(username, password, service=Config.PAM_SERVICE)}
    except Exception as e:
        return {"success": False, "error": "Auth failed: " + str(e)}
